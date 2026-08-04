/**
 * Snapshot Management
 *
 * Maps conversation entry IDs to git tree hashes in the shadow repo.
 * Snapshots are tree hashes (never commits). Persistence is stored in a
 * sidecar JSON file per session.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

import { gitShadow, gitSource, MAX_FILE_SIZE, type ShadowGitConfig, withRepoLock } from "./shadow-git";

interface PersistedSnapshots {
    initial: string;
    snapshots: Record<string, string>;
}

function encodeNulTerminatedPaths(files: string[]): string {
    return files.join("\0") + "\0";
}

function encodeTopLevelLiteralPathspecs(files: string[]): string {
    return encodeNulTerminatedPaths(files.map(file => `:(top,literal)${file}`));
}

function sidecarPath(config: ShadowGitConfig): string {
    return path.join(config.shadowDir, `${config.sessionKey}.json`);
}

export class SnapshotStore {
    public config: ShadowGitConfig;
    private snapshots = new Map<string, string>();
    private initial?: string;
    private persisted: boolean;

    constructor(config: ShadowGitConfig) {
        this.config = config;
        this.persisted = false;
        this.load();
    }

    private load(): void {
        const file = sidecarPath(this.config);
        if (!fs.existsSync(file)) return;
        try {
            const data = JSON.parse(fs.readFileSync(file, "utf8")) as PersistedSnapshots;
            if (data.initial) {
                this.initial = data.initial;
            }
            for (const [key, value] of Object.entries(data.snapshots)) {
                this.snapshots.set(key, value);
            }
            this.persisted = true;
        }
        catch {
            // Ignore corrupt sidecar; start fresh.
        }
    }

    private save(): void {
        const file = sidecarPath(this.config);
        const data: PersistedSnapshots = {
            initial: this.initial ?? "",
            snapshots: Object.fromEntries(this.snapshots),
        };
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
        fs.renameSync(tmp, file);
    }

    /**
     * Ensure the pre-pi baseline tree exists for this session. Lazy; no-op if
     * already loaded or created.
     */
    async ensureInitial(ctx: ExtensionContext): Promise<string | undefined> {
        if (this.initial) return this.initial;
        return await this.snapshotTree("initial", ctx, true);
    }

    /**
     * Create a snapshot from the current working tree. Returns the tree hash if
     * the tree changed, or undefined if the tree is identical to the latest one.
     */
    async createSnapshot(key: string, ctx: ExtensionContext): Promise<string | undefined> {
        return await this.snapshotTree(key, ctx, false);
    }

    private async snapshotTree(
        key: string,
        ctx: ExtensionContext,
        isInitial: boolean,
    ): Promise<string | undefined> {
        const { shadowDir, cwd } = this.config;

        return await withRepoLock(shadowDir, async () => {
            await this.syncExcludes(ctx, []);

            const diffArgs = ["diff-files", "--name-only", "-z", "--", "."];
            const otherArgs = ["ls-files", "--full-name", "--others", "--exclude-standard", "-z", "--", "."];
            const [diff, other] = await Promise.all([
                gitShadow(shadowDir, cwd, diffArgs, ctx),
                gitShadow(shadowDir, cwd, otherArgs, ctx),
            ]);

            if (!diff.ok || !other.ok) {
                ctx.ui.notify("Failed to list files for snapshot", "warning");
                return undefined;
            }

            const tracked = diff.stdout.split("\0").filter(Boolean);
            const untracked = other.stdout.split("\0").filter(Boolean);
            const all = Array.from(new Set([...tracked, ...untracked]));

            if (!all.length && !isInitial) {
                // No files and not initial: nothing changed.
                return undefined;
            }

            // Drop ignored files from the snapshot index.
            const ignored = await this.checkIgnored(all, ctx);
            if (ignored.size > 0) {
                await this.dropIgnored(Array.from(ignored), ctx);
            }

            const allowed = all.filter(item => !ignored.has(item));
            if (!allowed.length && !isInitial) {
                return undefined;
            }

            // Block large untracked files from future snapshots.
            const block = new Set<string>();
            for (const item of allowed) {
                if (!untracked.includes(item)) continue;
                const absPath = path.isAbsolute(item) ? item : path.join(cwd, item);
                const size = await this.getFileSizeSafe(absPath);
                if (size > MAX_FILE_SIZE) {
                    block.add(item);
                }
            }

            if (block.size > 0) {
                await this.syncExcludes(ctx, Array.from(block));
            }

            // Stage only the allowed non-blocked paths.
            const stagePaths = allowed.filter(item => !block.has(item));
            if (stagePaths.length > 0) {
                const stageResult = await gitShadow(
                    shadowDir,
                    cwd,
                    ["add", "--all", "--sparse", "--pathspec-from-file=-", "--pathspec-file-nul"],
                    ctx,
                    encodeTopLevelLiteralPathspecs(stagePaths),
                );
                if (!stageResult.ok) {
                    ctx.ui.notify("Failed to stage snapshot files", "warning");
                    return undefined;
                }
            }

            const writeResult = await gitShadow(shadowDir, cwd, ["write-tree"], ctx);
            if (!writeResult.ok) {
                ctx.ui.notify("Failed to write snapshot tree", "warning");
                return undefined;
            }

            const treeHash = writeResult.stdout.trim();
            if (!treeHash) {
                return undefined;
            }

            // For non-initial snapshots, skip if the tree matches the latest one.
            if (!isInitial) {
                const latestTree = this.getLatestTree();
                if (latestTree === treeHash) {
                    return undefined;
                }
            }

            if (isInitial) {
                this.initial = treeHash;
            }
            else {
                this.snapshots.set(key, treeHash);
            }
            this.save();
            return treeHash;
        });
    }

    private getLatestTree(): string | undefined {
        if (this.snapshots.size === 0) return this.initial;
        return Array.from(this.snapshots.values()).pop();
    }

    private async checkIgnored(files: string[], ctx: ExtensionContext): Promise<Set<string>> {
        if (files.length === 0 || !this.config.source) return new Set<string>();

        const guarded = files.map(item => (item.startsWith(":") ? `./${item}` : item));
        const result = await gitSource(
            this.config.cwd,
            ["--git-dir", this.config.source, "--work-tree", this.config.cwd, "check-ignore", "--no-index", "--stdin", "-z"],
            ctx,
            encodeNulTerminatedPaths(guarded),
        );

        if (!result.ok && result.exitCode !== 1) {
            return new Set<string>();
        }

        return new Set(
            result.stdout
                .split("\0")
                .filter(Boolean)
                .map(item => (item.startsWith("./:") ? item.slice(2) : item)),
        );
    }

    private async dropIgnored(files: string[], ctx: ExtensionContext): Promise<void> {
        const { shadowDir, cwd } = this.config;
        await gitShadow(
            shadowDir,
            cwd,
            ["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"],
            ctx,
            encodeTopLevelLiteralPathspecs(files),
        );
    }

    private async syncExcludes(ctx: ExtensionContext, block: string[]): Promise<void> {
        const { shadowDir, cwd, source } = this.config;
        const target = path.join(shadowDir, ".git", "info", "exclude");
        fs.mkdirSync(path.dirname(target), { recursive: true });

        let sourceText = "";
        if (source) {
            const sourceExclude = path.join(source, "info", "exclude");
            if (fs.existsSync(sourceExclude)) {
                sourceText = fs.readFileSync(sourceExclude, "utf8").trimEnd();
            }
        }

        // Always exclude the sidecar persistence file from the shadow repo.
        const sidecar = path.relative(cwd, sidecarPath(this.config)).replace(/\\/g, "/");
        const excludes = [
            sourceText,
            sidecar ? `/${sidecar}` : undefined,
            ...block.map(item => `/${item.replace(/\\/g, "/")}`),
        ].filter((item): item is string => Boolean(item));
        const text = excludes.length > 0 ? `${excludes.join("\n")}\n` : "";
        fs.writeFileSync(target, text, "utf8");
    }

    private async getFileSizeSafe(filePath: string): Promise<number> {
        try {
            const stat = await fs.promises.stat(filePath);
            return stat.isFile() ? stat.size : 0;
        }
        catch {
            return 0;
        }
    }

    /**
     * Find the snapshot tree hash for an entry ID.
     * Walks up the parent chain if the entry itself has no snapshot.
     * Falls back to the initial state when no snapshot is found.
     */
    async findSnapshot(
        entryId: string,
        ctx: ExtensionContext,
    ): Promise<string | undefined> {
        let currentId: string | null = entryId;
        const visited = new Set<string>();

        while (currentId) {
            if (visited.has(currentId)) break;
            visited.add(currentId);

            const entry = ctx.sessionManager?.getEntry?.(currentId);
            const toolKey = entry ? toolSnapshotKey(entry) : undefined;
            if (toolKey && this.snapshots.has(toolKey)) {
                return this.snapshots.get(toolKey);
            }

            if (this.snapshots.has(currentId)) {
                return this.snapshots.get(currentId);
            }

            const parentId = (entry as { parentId?: string | null } | undefined)?.parentId;
            if (!parentId) break;
            currentId = parentId;
        }

        return this.initial;
    }

    /**
     * Get all stored snapshots (for testing).
     */
    getAll(): Map<string, string> {
        return this.snapshots;
    }

    /**
     * Get the initial tree hash, if any.
     */
    getInitialStateCommit(): string | undefined {
        return this.initial;
    }
}

/**
 * Compute the synthetic snapshot key for a toolResult entry:
 * `${issuingAssistantId}:${toolCallId}`.
 */
function toolSnapshotKey(entry: unknown): string | undefined {
    const e = entry as {
        type?: string;
        parentId?: string | null;
        message?: { role?: string; toolCallId?: string };
    };
    if (e?.type === "message" && e.parentId && e.message?.role === "toolResult" && e.message.toolCallId) {
        return `${e.parentId}:${e.message.toolCallId}`;
    }
    return undefined;
}
