import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { discoverAgents } from "../agents";
import type { AgentConfig } from "../types";

function writeAgent(dir: string, name: string, content: string) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, name), content, "utf-8");
}

function names(agents: AgentConfig[]): string[] {
    return agents.map(a => a.name).sort();
}

function findAgent(agents: AgentConfig[], name: string): AgentConfig | undefined {
    return agents.find(a => a.name === name);
}

describe("discoverAgents", () => {
    let tmpDir: string;
    let originalHome: string | undefined;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "subagent-test-"));
        originalHome = process.env["HOME"];
        process.env["HOME"] = tmpDir;
    });

    afterEach(() => {
        process.env["HOME"] = originalHome;
    });

    test("loads user/global claude agents", () => {
        const claudeDir = path.join(tmpDir, ".claude", "agents");
        writeAgent(claudeDir, "reviewer.md", "---\ndescription: Code reviewer\n---\nReview code.");

        const result = discoverAgents(tmpDir, "user");
        expect(names(result.agents)).toEqual(["Explore", "reviewer"]);
        expect(findAgent(result.agents, "reviewer")?.source).toBe("user");
    });

    test("loads user/global opencode agents", () => {
        const opencodeDir = path.join(tmpDir, ".config", "opencode", "agents");
        writeAgent(opencodeDir, "worker.md", "---\nname: worker\nrole: Generic worker\n---\nDo work.");

        const result = discoverAgents(tmpDir, "user");
        expect(names(result.agents)).toEqual(["Explore", "worker"]);
        expect(findAgent(result.agents, "worker")?.source).toBe("user");
    });

    test("loads project-local claude and opencode agents", () => {
        const projectClaudeDir = path.join(tmpDir, "project", ".claude", "agents");
        const projectOpencodeDir = path.join(tmpDir, "project", ".opencode", "agents");
        writeAgent(projectClaudeDir, "reviewer.md", "---\ndescription: Project reviewer\n---\nProject review.");
        writeAgent(projectOpencodeDir, "worker.md", "---\nname: worker\nrole: Project worker\n---\nProject work.");

        const result = discoverAgents(path.join(tmpDir, "project"), "project");
        expect(names(result.agents)).toEqual(["Explore", "reviewer", "worker"]);
        const reviewer = findAgent(result.agents, "reviewer")!;
        expect(reviewer.source).toBe("project");
        expect(reviewer.systemPrompt).toContain("Project review.");
    });

    test("walks upward to find project-local agents", () => {
        const projectClaudeDir = path.join(tmpDir, "project", ".claude", "agents");
        writeAgent(projectClaudeDir, "reviewer.md", "---\ndescription: Project reviewer\n---\nProject review.");

        const deepDir = path.join(tmpDir, "project", "src", "deep");
        fs.mkdirSync(deepDir, { recursive: true });
        const result = discoverAgents(deepDir, "project");
        expect(names(result.agents)).toEqual(["Explore", "reviewer"]);
    });

    test("project-local agents override user agents with same name", () => {
        const userDir = path.join(tmpDir, ".claude", "agents");
        const projectDir = path.join(tmpDir, "project", ".claude", "agents");
        writeAgent(userDir, "reviewer.md", "---\ndescription: User reviewer\n---\nUser review.");
        writeAgent(projectDir, "reviewer.md", "---\ndescription: Project reviewer\n---\nProject review.");

        const result = discoverAgents(path.join(tmpDir, "project"), "both");
        const reviewer = findAgent(result.agents, "reviewer")!;
        expect(reviewer.source).toBe("project");
        expect(reviewer.systemPrompt).toContain("Project review.");
    });

    test("claude agents take precedence over opencode agents at same scope", () => {
        const projectClaudeDir = path.join(tmpDir, "project", ".claude", "agents");
        const projectOpencodeDir = path.join(tmpDir, "project", ".opencode", "agents");
        writeAgent(projectClaudeDir, "reviewer.md", "---\ndescription: Claude reviewer\n---\nClaude review.");
        writeAgent(projectOpencodeDir, "reviewer.md", "---\nname: reviewer\nrole: Opencode reviewer\n---\nOpencode review.");

        const result = discoverAgents(path.join(tmpDir, "project"), "both");
        const reviewer = findAgent(result.agents, "reviewer")!;
        expect(reviewer.systemPrompt).toContain("Claude review.");
    });

    test("scope=user excludes project-local agents", () => {
        const userDir = path.join(tmpDir, ".claude", "agents");
        const projectDir = path.join(tmpDir, "project", ".claude", "agents");
        writeAgent(userDir, "user-agent.md", "---\ndescription: User agent\n---\nUser.");
        writeAgent(projectDir, "project-agent.md", "---\ndescription: Project agent\n---\nProject.");

        const result = discoverAgents(path.join(tmpDir, "project"), "user");
        expect(names(result.agents)).toEqual(["Explore", "user-agent"]);
    });

    test("scope=project excludes user agents", () => {
        const userDir = path.join(tmpDir, ".claude", "agents");
        const projectDir = path.join(tmpDir, "project", ".claude", "agents");
        writeAgent(userDir, "user-agent.md", "---\ndescription: User agent\n---\nUser.");
        writeAgent(projectDir, "project-agent.md", "---\ndescription: Project agent\n---\nProject.");

        const result = discoverAgents(path.join(tmpDir, "project"), "project");
        expect(names(result.agents)).toEqual(["Explore", "project-agent"]);
    });

    test("parses claude frontmatter tools/disallowedTools", () => {
        const claudeDir = path.join(tmpDir, ".claude", "agents");
        writeAgent(
            claudeDir,
            "smart.md",
            "---\ndescription: Smart agent\nmodel: anthropic/claude-sonnet-4-20250514\ntools: Read, Grep, Glob, Bash\ndisallowedTools: Edit\n---\nBe smart.",
        );

        const result = discoverAgents(tmpDir, "user");
        const agent = findAgent(result.agents, "smart")!;
        expect(agent.description).toBe("Smart agent");
        expect(agent.model).toBe("anthropic/claude-sonnet-4-20250514");
        expect(agent.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
        expect(agent.disallowedTools).toEqual(["Edit"]);
        expect(agent.permissions).toBeUndefined();
        expect(agent.systemPrompt).toContain("Be smart.");
    });

    test("parses opencode frontmatter fields", () => {
        const opencodeDir = path.join(tmpDir, ".config", "opencode", "agents");
        writeAgent(
            opencodeDir,
            "helper.md",
            "---\nname: helper\nrole: Helpful agent\nmodel: openai/gpt-4o\npermission:\n  read: allow\n  write: ask\n---\nBe helpful.",
        );

        const result = discoverAgents(tmpDir, "user");
        const agent = findAgent(result.agents, "helper")!;
        expect(agent.name).toBe("helper");
        expect(agent.description).toBe("Helpful agent");
        expect(agent.model).toBe("openai/gpt-4o");
        expect(agent.permissions).toEqual({ read: "allow", write: "ask" });
    });

    test("opencode name falls back to filename stem", () => {
        const opencodeDir = path.join(tmpDir, ".config", "opencode", "agents");
        writeAgent(opencodeDir, "fallback.md", "---\nrole: Fallback agent\n---\nFallback.");

        const result = discoverAgents(tmpDir, "user");
        expect(names(result.agents)).toEqual(["Explore", "fallback"]);
    });

    test("ignores agent files without description or role", () => {
        const claudeDir = path.join(tmpDir, ".claude", "agents");
        writeAgent(claudeDir, "no-desc.md", "---\nmodel: foo\n---\nNo desc.");
        writeAgent(claudeDir, "valid.md", "---\ndescription: Valid agent\n---\nValid.");

        const result = discoverAgents(tmpDir, "user");
        expect(names(result.agents)).toEqual(["Explore", "valid"]);
    });

    test("ignores non-md files and directories", () => {
        const claudeDir = path.join(tmpDir, ".claude", "agents");
        fs.mkdirSync(claudeDir, { recursive: true });
        fs.writeFileSync(path.join(claudeDir, "notes.txt"), "not an agent", "utf-8");
        fs.mkdirSync(path.join(claudeDir, "subdir"));
        writeAgent(claudeDir, "valid.md", "---\ndescription: Valid agent\n---\nValid.");

        const result = discoverAgents(tmpDir, "user");
        expect(names(result.agents)).toEqual(["Explore", "valid"]);
    });

    test("returns built-in agents when no user agents exist", () => {
        const result = discoverAgents(tmpDir, "both");
        expect(names(result.agents)).toEqual(["Explore"]);
        expect(result.projectClaudeAgentsDir).toBeNull();
        expect(result.projectOpencodeAgentsDir).toBeNull();
    });

    test("user agents override built-in agents with the same name", () => {
        const claudeDir = path.join(tmpDir, ".claude", "agents");
        writeAgent(claudeDir, "Explore.md", "---\ndescription: Custom plan agent\n---\nCustom plan.");

        const result = discoverAgents(tmpDir, "user");
        const plan = findAgent(result.agents, "Explore")!;
        expect(plan.source).toBe("user");
        expect(plan.systemPrompt).toContain("Custom plan.");
    });

    test("user agents override built-in Explore agent with the same name", () => {
        const claudeDir = path.join(tmpDir, ".claude", "agents");
        writeAgent(claudeDir, "Explore.md", "---\ndescription: Custom explore agent\n---\nCustom explore.");

        const result = discoverAgents(tmpDir, "user");
        const explore = findAgent(result.agents, "Explore")!;
        expect(explore.source).toBe("user");
        expect(explore.systemPrompt).toContain("Custom explore.");
    });
});
