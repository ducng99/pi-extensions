/**
 * Subagent discovery and frontmatter parsing.
 *
 * Discovers Markdown agent definitions from the following locations:
 *   - User/global Claude agents: ~/.claude/agents/*.md
 *   - Project-local Claude agents: <cwd>/.claude/agents/*.md (searched upward)
 */

import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import * as fs from "fs";
import { homedir } from "os";
import * as path from "path";

import exploreAgent from "./defaultAgents/explore";
import type { AgentConfig, AgentDiscoveryResult, DefaultAgentDefinition } from "./types";

// ============================================================================
// Constants
// ============================================================================

const CLAUDE_AGENTS_DIR = "agents";

// ============================================================================
// Helpers
// ============================================================================

function getHomeDir(): string {
    return process.env.HOME ?? process.env.USERPROFILE ?? homedir();
}

function userClaudeDir(): string {
    return path.join(getHomeDir(), ".claude", CLAUDE_AGENTS_DIR);
}

function isDirectory(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}

function isFile(p: string): boolean {
    try {
        return fs.statSync(p).isFile();
    }
    catch {
        return false;
    }
}

function findNearestProjectDir(cwd: string, brandDir: string): string | null {
    let currentDir = cwd;
    while (true) {
        const candidate = path.join(currentDir, brandDir, "agents");
        if (isDirectory(candidate)) return candidate;

        const parentDir = path.dirname(currentDir);
        if (parentDir === currentDir) return null;
        currentDir = parentDir;
    }
}

function fileNameStem(fileName: string): string {
    return path.basename(fileName, ".md");
}

function isString(value: unknown): value is string {
    return typeof value === "string";
}

function parseToolsList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(v => String(v));
    if (typeof value === "string") return value.split(",").map(s => s.trim()).filter(Boolean);
    return [];
}

function parseFrontmatterValue(value: unknown): string | undefined {
    if (value === null || value === undefined) return undefined;
    if (isString(value)) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return undefined;
}

// ============================================================================
// Loading from a directory
// ============================================================================

function loadDefaultAgent(definition: DefaultAgentDefinition, filePath: string): AgentConfig {
    return {
        name: definition.name,
        description: definition.description,
        model: definition.model,
        systemPrompt: definition.systemPrompt,
        source: "default",
        filePath,
    };
}

function loadDefaultAgents(): AgentConfig[] {
    return [
        loadDefaultAgent(exploreAgent, "default:Explore"),
    ];
}

function loadAgentsFromDir(dir: string, source: "user" | "project"): AgentConfig[] {
    const agents: AgentConfig[] = [];
    if (!isDirectory(dir)) return agents;

    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return agents;
    }

    for (const entry of entries) {
        if (!entry.name.endsWith(".md")) continue;
        if (!entry.isFile() && !entry.isSymbolicLink()) continue;

        const filePath = path.join(dir, entry.name);
        if (!isFile(filePath)) continue;

        let content: string;
        try {
            content = fs.readFileSync(filePath, "utf-8");
        }
        catch {
            continue;
        }

        const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
        const stem = fileNameStem(entry.name);

        const name = parseFrontmatterValue(frontmatter.name) ?? stem;
        const description = parseFrontmatterValue(frontmatter.description) ?? parseFrontmatterValue(frontmatter.role) ?? "";
        if (!description) continue;

        const model = parseFrontmatterValue(frontmatter.model);
        const tools = parseToolsList(frontmatter.tools);
        const disallowedTools = parseToolsList(frontmatter.disallowedTools);

        agents.push({
            name,
            description,
            model,
            systemPrompt: body,
            source,
            filePath,
            tools: tools.length > 0 ? tools : undefined,
            disallowedTools: disallowedTools.length > 0 ? disallowedTools : undefined,
        });
    }

    return agents;
}

// ============================================================================
// Discovery
// ============================================================================

export function discoverAgents(cwd: string): AgentDiscoveryResult {
    const projectClaudeAgentsDir = findNearestProjectDir(cwd, ".claude");

    const userClaudeAgents = loadAgentsFromDir(userClaudeDir(), "user");
    const projectClaudeAgents = !projectClaudeAgentsDir ? [] : loadAgentsFromDir(projectClaudeAgentsDir, "project");

    const agentMap = new Map<string, AgentConfig>();

    // Priority order, lowest to highest:
    // 1. Built-in default agents
    // 2. User-level Claude
    // 3. Project-local Claude
    // Default agents are loaded first so any user-defined agent with the same
    // name overrides the built-in definition.
    const defaultAgents = loadDefaultAgents();
    for (const agent of defaultAgents) agentMap.set(agent.name, agent);
    for (const agent of userClaudeAgents) agentMap.set(agent.name, agent);
    for (const agent of projectClaudeAgents) agentMap.set(agent.name, agent);

    return {
        agents: Array.from(agentMap.values()),
        projectClaudeAgentsDir,
    };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
    if (agents.length === 0) return { text: "none", remaining: 0 };
    const listed = agents.slice(0, maxItems);
    const remaining = agents.length - listed.length;
    return {
        text: listed.map(a => `${a.name} (${a.source}): ${a.description}`).join("; "),
        remaining,
    };
}
