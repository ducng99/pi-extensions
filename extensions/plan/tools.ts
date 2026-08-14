import type { ParsedPermissions } from "../tool-permissions/src/permission-parsing";

/** Tools available while plan mode is active. */
export const PLAN_TOOL_NAMES = new Set(["read", "bash", "grep", "find", "ls", "ask_user_questions", "webfetch", "websearch", "write_plan", "edit_plan"]);

/** Plan tools whose completion should trigger the "what next?" prompt. */
export const PLAN_WRITE_TOOLS = new Set(["write_plan", "edit_plan"]);

/**
 * Plan-mode permission set emitted so tool-permissions can gate plan-mode tool
 * calls. It is deny-focused: mutating tools and destructive bash commands are
 * blocked outright, while everything else flows through the user's own settings
 * (bash defaults to "ask" when not explicitly allowed).
 */
export const PLAN_MODE_PERMISSIONS: ParsedPermissions = {
    allow: [
        { category: "write_plan", pattern: "" },
        { category: "edit_plan", pattern: "" },
    ],
    ask: [],
    deny: [
        { category: "edit", pattern: "*" },
        { category: "write", pattern: "*" },
        // Filesystem mutators
        { category: "bash", pattern: "rm *" },
        { category: "bash", pattern: "mv *" },
        { category: "bash", pattern: "cp *" },
        { category: "bash", pattern: "touch *" },
        { category: "bash", pattern: "mkdir *" },
        { category: "bash", pattern: "rmdir *" },
        { category: "bash", pattern: "chmod *" },
        { category: "bash", pattern: "chown *" },
        { category: "bash", pattern: "ln *" },
        { category: "bash", pattern: "truncate *" },
        { category: "bash", pattern: "shred *" },
        { category: "bash", pattern: "dd *" },
        { category: "bash", pattern: "tee *" },
        { category: "bash", pattern: "install *" },
        { category: "bash", pattern: "sed -i *" },
        // Version control
        { category: "bash", pattern: "git add *" },
        { category: "bash", pattern: "git commit *" },
        { category: "bash", pattern: "git push *" },
        { category: "bash", pattern: "git pull *" },
        { category: "bash", pattern: "git reset *" },
        { category: "bash", pattern: "git checkout *" },
        { category: "bash", pattern: "git clean *" },
        { category: "bash", pattern: "git rm *" },
        { category: "bash", pattern: "git stash *" },
        { category: "bash", pattern: "git merge *" },
        { category: "bash", pattern: "git rebase *" },
        // Package managers / build tools
        { category: "bash", pattern: "npm install *" },
        { category: "bash", pattern: "npm run *" },
        { category: "bash", pattern: "pnpm install *" },
        { category: "bash", pattern: "pnpm run *" },
        { category: "bash", pattern: "bun install *" },
        { category: "bash", pattern: "bun run *" },
        { category: "bash", pattern: "yarn *" },
        { category: "bash", pattern: "pnpm *" },
        { category: "bash", pattern: "make *" },
        { category: "bash", pattern: "pip install *" },
        { category: "bash", pattern: "apt *" },
        { category: "bash", pattern: "apt-get *" },
        { category: "bash", pattern: "brew *" },
    ],
    additionalDirectories: [],
};
