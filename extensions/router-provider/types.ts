export interface ModelData {
    id: string;
    object: string;
    owned_by: string;
    capabilities?: Capabilities;
    context_length?: number;
    max_completion_tokens?: number;
}

export interface Capabilities {
    vision: boolean;
    pdf: boolean;
    audioInput: boolean;
    videoInput: boolean;
    imageOutput: boolean;
    audioOutput: boolean;
    search: boolean;
    tools: boolean;
    reasoning: boolean;
    thinkingFormat: null | string;
    thinkingCanDisable: boolean;
    thinkingRange: null;
    contextWindow: number;
    maxOutput: number;
}
