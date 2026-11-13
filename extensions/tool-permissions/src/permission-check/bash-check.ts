import { parseBashCommand } from "../../../shared/bash-parser/index";
import { matchPattern } from "../../../shared/pattern-matching/index";
import { classifyToolCall } from "../classifier";
import type { ParsedPermissions } from "../permission-parsing";
import type { ClassifierSessionContext } from "../session-context";
import { DEFAULT_ALLOWED_BASH_COMMANDS } from "../tool-categories";
import { appendLog } from "./log";
import { resolveModeFallback } from "./mode-fallback";
import { extractPathArgs, extractRedirectionPaths } from "./path-extraction";
import { isOutOfBoundsPath, isSensitivePath, resolveArgPath } from "./paths";
import type { PermissionDecision, PermissionMode, SessionContextProvider, SessionEntriesProvider } from "./types";
import { REASON_BASH_COMPLEX, REASON_BASH_PARSE_ERROR } from "./types";
import { stripWrapperCommands } from "./wrapper-strip";

/**
 * Extract and validate the target directory of a `cd <path>` command.
 * Returns the resolved path if the cd is in-bounds, otherwise null.
 */
function getCdTarget(
    args: string[],
    resolveCwd: string,
    boundaryCwd: string,
    additionalDirs: string[],
    isSessionAllowed?: (path: string) => boolean,
): string | null {
    if (args.length < 1 || args[0] !== "cd") return null;

    let targetPath = "";
    for (let i = 1; i < args.length; i++) {
        const arg = args[i]!;
        if (arg === "--") continue;
        if (!arg.startsWith("-")) {
            targetPath = arg;
            break;
        }
    }
    if (!targetPath) return null;

    const resolved = resolveArgPath(targetPath, resolveCwd);
    if (isSensitivePath(resolved, boundaryCwd)) return null;
    if (isOutOfBoundsPath(targetPath, resolveCwd, boundaryCwd, additionalDirs) && !isSessionAllowed?.(resolved)) return null;
    return resolved;
}

/**
 * Check if any path in a single command points to a sensitive directory
 * (.pi, .claude, or .mcp.json under the boundary cwd). The plans
 * subdirectories (.pi/plans, .claude/plans) are exempt.
 */
function isCommandOnSensitivePath(
    args: string[],
    argString: string,
    resolveCwd: string,
    boundaryCwd: string,
): boolean {
    for (const path of extractPathArgs(args)) {
        if (path === "/dev/null" || /^nul:?$/i.test(path)) continue;
        if (isSensitivePath(resolveArgPath(path, resolveCwd), boundaryCwd)) return true;
    }
    for (const path of extractRedirectionPaths(argString)) {
        if (path === "/dev/null" || /^nul:?$/i.test(path)) continue;
        if (isSensitivePath(resolveArgPath(path, resolveCwd), boundaryCwd)) return true;
    }
    return false;
}

/**
 * Find the first path in a single command that is outside the effective cwd
 * and additional directories. Returns the resolved path, or null when every
 * path is in-bounds.
 */
function findOutOfBoundsPath(
    args: string[],
    argString: string,
    resolveCwd: string,
    boundaryCwd: string,
    additionalDirs: string[],
    isSessionAllowed?: (path: string) => boolean,
): string | null {
    for (const path of extractPathArgs(args)) {
        // Skip /dev/null (POSIX) and NUL (Windows) null devices — they are
        // not real filesystem paths and should never trigger out-of-bounds.
        if (path === "/dev/null" || /^nul:?$/i.test(path)) continue;
        const resolved = resolveArgPath(path, resolveCwd);
        if (!isOutOfBoundsPath(path, resolveCwd, boundaryCwd, additionalDirs)) continue;
        if (isSessionAllowed?.(resolved)) continue;
        return resolved;
    }
    for (const path of extractRedirectionPaths(argString)) {
        const resolved = resolveArgPath(path, resolveCwd);
        if (!isOutOfBoundsPath(path, resolveCwd, boundaryCwd, additionalDirs)) continue;
        if (isSessionAllowed?.(resolved)) continue;
        return resolved;
    }
    return null;
}

/**
 * Check bash command permissions.
 *
 * Flow for each parsed sub-command:
 *   1. Deny match    → deny tool call
 *   2. Ask match     → ask user
 *   3. Out-of-bounds → ask user
 *   4. Allow match   → resolved
 *   5. cd in-bounds  → resolved (auto-allow)
 *   6. Query classifier
 *   7. Otherwise     → ask user
 */
export async function checkBashPermission(
    input: Record<string, unknown>,
    merged: ParsedPermissions,
    cwd: string,
    getMode?: () => PermissionMode,
    signal?: AbortSignal,
    sessionContextProvider?: SessionContextProvider,
    sessionEntriesProvider?: SessionEntriesProvider,
    isSessionAllowed?: (path: string) => boolean,
): Promise<PermissionDecision> {
    const cmd = input.command;
    if (typeof cmd !== "string") return { decision: "ask" };

    const category = "bash";

    // 1. Parse with tree-sitter first.
    const parseResult = parseBashCommand(cmd);

    if (parseResult.kind === "error") {
        return { decision: "ask", reason: REASON_BASH_PARSE_ERROR };
    }

    // Wrapper keywords execute their remainder,
    // so evaluate the wrapped commands without them.
    const commands = parseResult.commands.flatMap(stripWrapperCommands);
    if (commands.length === 0) {
        return { decision: "allow" };
    }

    // 1. Deny
    for (const leafCmd of commands) {
        for (const rule of merged.deny) {
            if (rule.category === category && matchPattern(rule.pattern, leafCmd.argString)) {
                return { decision: "deny" };
            }
        }
    }

    // 2. Ask
    for (const leafCmd of commands) {
        for (const rule of merged.ask) {
            if (rule.category === category && matchPattern(rule.pattern, leafCmd.argString)) {
                return { decision: "ask" };
            }
        }
    }

    // The session context snapshot is built once per command (lazily, on the
    // first leaf that reaches the classifier) and reused across all leaves in
    // this command — so a multi-leaf command issues a single `git status`.
    let sessionCtx: ClassifierSessionContext | undefined;
    let sessionCtxLoaded = false;
    const getSessionCtx = async (): Promise<ClassifierSessionContext | undefined> => {
        if (!sessionContextProvider) return undefined;
        if (!sessionCtxLoaded) {
            sessionCtx = await sessionContextProvider();
            sessionCtxLoaded = true;
        }
        return sessionCtx;
    };

    // 3. Out-of-bounds check + 4. Allow / cd auto-allow
    // Process commands in order so that `cd` changes the effective cwd for
    // subsequent relative paths. The *boundary* (`cwd`) stays fixed at the
    // original session cwd throughout — only the base used to resolve
    // relative paths (`effectiveCwd`) tracks `cd`s, so moving back up the
    // tree (e.g. `cd sub && ... && cd ../..`) is correctly recognized as
    // staying within bounds.
    let effectiveCwd = cwd;
    let shouldAllow: PermissionDecision = { decision: "allow" };

    for (const leafCmd of commands) {
        const additionalDirs = merged.additionalDirectories ?? [];

        // 3. Out-of-bounds check for this command using the effective cwd to
        // resolve relative paths, but the original session cwd as the bound.
        const outOfBoundsPath = effectiveCwd
            ? findOutOfBoundsPath(leafCmd.args, leafCmd.argString, effectiveCwd, cwd, additionalDirs, isSessionAllowed)
            : null;
        if (outOfBoundsPath) {
            return {
                decision: "ask",
                reason: `⚠ Accessing outside allowed directories: ${outOfBoundsPath}`,
                outOfBoundsPath,
            };
        }

        // 3b. Sensitive path check: paths inside .pi/.claude must always ask
        // (the plans subdirectories are exempt — they hold only the agent's
        // own notes, not permission rules).
        if (effectiveCwd && isCommandOnSensitivePath(leafCmd.args, leafCmd.argString, effectiveCwd, cwd)) {
            return { decision: "ask", reason: "⚠ Accessing sensitive files/directories." };
        }

        // Complex leaves only get deny-rule checking (already done above); for
        // everything else, ask — or consult the classifier in automode.
        if (leafCmd.isComplex) {
            shouldAllow = { decision: "ask", reason: REASON_BASH_COMPLEX };
            break;
        }

        // 4a. `cd` auto-allow, and update the effective cwd for later commands.
        if (effectiveCwd) {
            const cdTarget = getCdTarget(leafCmd.args, effectiveCwd, cwd, additionalDirs, isSessionAllowed);
            if (cdTarget) {
                effectiveCwd = cdTarget;
                continue;
            }
        }

        // 4b. Allow rule match.
        let allowMatched = false;
        for (const rule of merged.allow) {
            if (rule.category === category && matchPattern(rule.pattern, leafCmd.argString)) {
                allowMatched = true;
                break;
            }
        }
        if (allowMatched) continue;

        // 4c. Default allowed bash commands (safe, cannot read file contents).
        if (leafCmd.args.length > 0 && DEFAULT_ALLOWED_BASH_COMMANDS.has(leafCmd.args[0]!)) {
            continue;
        }

        shouldAllow = { decision: "ask" };
    }

    if (shouldAllow.decision === "ask") {
        // Log context + bash command for LLM training data
        const sessionCtx = await getSessionCtx();
        appendLog({
            command: cmd,
            cwd,
            gitRemote: sessionCtx?.gitRemote,
            gitStatus: sessionCtx?.gitStatus,
            recentToolCalls: sessionCtx?.recentToolCalls,
            agentTouchedFiles: sessionCtx?.agentTouchedFiles,
            lastUserPrompt: sessionCtx?.lastUserPrompt,
            category: "bash",
            reason: shouldAllow.reason,
        }).catch(() => {});
        const mode = getMode?.() ?? "off";
        if (mode === "allow") return { decision: "allow" };
        if (mode === "auto") {
            return await resolveModeFallback("bash", input, mode, signal, async () =>
                classifyToolCall("bash", input, signal, await getSessionCtx(), sessionEntriesProvider?.(), merged),
            );
        }
        return { decision: "ask", reason: shouldAllow.reason };
    }

    return { decision: "allow" };
}
