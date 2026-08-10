/**
 * Tree Navigation Restore
 *
 * Restores the working tree to a snapshot tree hash when the user navigates
 * via /tree. Uses tree hashes only (no commits).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";

import { gitShadow, type ShadowGitConfig, withRepoLock } from "./shadow-git";
import type { SnapshotStore } from "./snapshots";

export type RestoreAction = "yes" | "no" | "cancel";

/**
 * Check whether restoring to a snapshot would change the working tree, and
 * prompt the user when it would. Returns "yes" to proceed with restore,
 * "no" to skip the restore but continue navigation, or "cancel" to abort
 * the tree navigation entirely.
 */
export async function checkRestore(
    targetId: string,
    snapshotStore: SnapshotStore,
    config: ShadowGitConfig,
    ctx: ExtensionContext,
): Promise<RestoreAction> {
    const snapshot = await snapshotStore.findSnapshot(targetId, ctx);
    if (!snapshot) {
        return "yes";
    }

    const diff = await gitShadow(config.shadowDir, config.cwd, ["diff", "--quiet", snapshot, "--", "."], ctx);
    if (diff.ok) {
        return "yes";
    }
    if (diff.exitCode !== 1) {
        return "yes";
    }

    // Get a short stat preview for the confirmation dialog.
    const numstat = await gitShadow(
        config.shadowDir,
        config.cwd,
        ["diff", "--numstat", snapshot, "--", "."],
        ctx,
    );
    let stats = "";
    if (numstat.ok) {
        const lines = numstat.stdout.split("\n").filter(Boolean);
        let additions = 0;
        let deletions = 0;
        let files = 0;
        for (const line of lines) {
            const [adds, dels] = line.split("\t");
            const a = parseInt(adds ?? "", 10);
            const d = parseInt(dels ?? "", 10);
            if (!Number.isNaN(a)) additions += a;
            if (!Number.isNaN(d)) deletions += d;
            files += 1;
        }
        stats = `\n\n${files} file${files === 1 ? "" : "s"}, +${additions} −${deletions}`;
    }

    const result = await ctx.ui.select(
        "Restore files?" + stats,
        [
            "Yes — restore files",
            "No — keep current files",
        ],
    );

    if (result === undefined) return "cancel";
    return result.startsWith("Yes") ? "yes" : "no";
}

/**
 * Restore the working tree to a snapshot tree hash.
 *
 * Uses `git read-tree` + `git checkout-index -a -f`, then deletes files that
 * were tracked in the shadow index before the restore but are absent from the
 * target tree. Does not move HEAD or create commits.
 */
export async function restoreToSnapshot(
    snapshot: string,
    config: ShadowGitConfig,
    ctx: ExtensionContext,
): Promise<void> {
    const { shadowDir, cwd } = config;

    await withRepoLock(shadowDir, async () => {
        const beforeFiles = await listTrackedFiles(shadowDir, cwd, ctx);

        const readResult = await gitShadow(shadowDir, cwd, ["read-tree", snapshot], ctx);
        if (!readResult.ok) {
            ctx.ui.notify(`Failed to read snapshot tree: ${readResult.stderr}`, "warning");
            return;
        }

        const checkoutResult = await gitShadow(shadowDir, cwd, ["checkout-index", "-a", "-f"], ctx);
        if (!checkoutResult.ok) {
            ctx.ui.notify(`Failed to restore files: ${checkoutResult.stderr}`, "warning");
            return;
        }

        const targetFiles = await listTreeFiles(snapshot, shadowDir, cwd, ctx);
        const toDelete = beforeFiles.filter(file => !targetFiles.has(file));

        for (const file of toDelete) {
            const absPath = path.join(cwd, file);
            try {
                if (fs.existsSync(absPath) && fs.lstatSync(absPath).isFile()) {
                    fs.unlinkSync(absPath);
                }
            }
            catch {
                // Ignore deletion errors.
            }
        }

        ctx.ui.notify("Files restored to conversation checkpoint", "info");
    });
}

async function listTrackedFiles(
    shadowDir: string,
    cwd: string,
    ctx: ExtensionContext,
): Promise<string[]> {
    const result = await gitShadow(shadowDir, cwd, ["ls-files", "-z"], ctx);
    if (!result.ok) return [];
    return result.stdout.split("\0").filter(Boolean);
}

async function listTreeFiles(
    snapshot: string,
    shadowDir: string,
    cwd: string,
    ctx: ExtensionContext,
): Promise<Set<string>> {
    const result = await gitShadow(shadowDir, cwd, ["ls-tree", "-r", "--name-only", "-z", snapshot], ctx);
    if (!result.ok) return new Set<string>();
    return new Set(result.stdout.split("\0").filter(Boolean));
}
