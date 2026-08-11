/**
 * Subagent extension types.
 */

export type AgentScope = "user" | "project" | "both";

export type DefaultAgentDefinition = Omit<AgentConfig, "source" | "filePath">;

export interface AgentConfig {
    name: string;
    description: string;
    model?: string;
    systemPrompt: string;
    source: "default" | "user" | "project";
    filePath: string;
    tools?: string[];
    disallowedTools?: string[];
}

export interface AgentDiscoveryResult {
    agents: AgentConfig[];
    projectClaudeAgentsDir: string | null;
}

export interface UsageStats {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens: number;
    turns: number;
}

export interface SingleResult {
    agent: string;
    agentSource: "default" | "user" | "project" | "unknown";
    task: string;
    exitCode: number;
    messages: Message[];
    stderr: string;
    usage: UsageStats;
    model?: string;
    stopReason?: string;
    errorMessage?: string;
    step?: number;
}

export interface BackgroundTaskInfo {
    backgroundId: string;
    pid: number;
    agent: string;
    task: string;
    outputPath: string;
    errorPath: string;
    startedAt: string;
}

export interface SubagentDetails {
    mode: "single" | "background";
    projectClaudeAgentsDir: string | null;
    results: SingleResult[];
    backgroundTasks?: BackgroundTaskInfo[];
}

export interface Message {
    role: "assistant" | "user" | "system";
    content: ContentPart[];
    usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        cost?: { total?: number };
        totalTokens?: number;
    };
    model?: string;
    stopReason?: string;
    errorMessage?: string;
}

export type ContentPart
    = | { type: "text"; text: string }
        | { type: "toolCall"; name: string; arguments: Record<string, unknown> };

export type DisplayItem
    = | { type: "text"; text: string }
        | { type: "toolCall"; name: string; args: Record<string, unknown> };
