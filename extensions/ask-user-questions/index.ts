/**
 * Ask User Questions Tool
 *
 * Replicates Claude Code's AskUserQuestion tool.
 * Asks the user 1-5 questions, each rendered as a tab.
 * Supports single-choice (radio) and multi-choice (checkbox) per question.
 * Final tab is a review/submit summary.
 */

import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createQuestionsComponent } from "./component";
import { renderCall, renderResult } from "./renderer";
import { AskQuestionsParams } from "./schema";
import type { AskQuestionsResult, Question } from "./types";

// ============================================================================
// Error helper
// ============================================================================

function errorResult(
    message: string,
    questions: Question[] = [],
): { content: { type: "text"; text: string }[]; details: AskQuestionsResult } {
    return {
        content: [{ type: "text", text: message }],
        details: { questions, answers: [], cancelled: true },
    };
}

// ============================================================================
// Extension
// ============================================================================

export default function askUserQuestions(pi: ExtensionAPI) {
    pi.registerTool({
        name: "ask_user_questions",
        label: "Ask User Questions",
        promptSnippet: "Ask the user up to 5 clarifying questions. Each question has pre-generated answer options, single-choice or multiple-choice",
        description: `
Usage notes:
- Users will always be able to select "Other" to provide custom text input
- Use multipleChoice: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
        `.trim(),
        promptGuidelines: [
            "Use ask_user_questions only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the code, or sensible defaults",
        ],
        parameters: AskQuestionsParams,

        async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
            if (ctx.mode !== "tui") {
                return errorResult("Error: UI not available (running in non-interactive mode)");
            }
            if (params.questions.length === 0) {
                return errorResult("Error: No questions provided");
            }
            if (params.questions.length > 5) {
                return errorResult("Error: Maximum 5 questions allowed");
            }

            const questions: Question[] = params.questions;

            const result = await ctx.ui.custom<AskQuestionsResult>((tui, theme, _kb, done) => {
                return createQuestionsComponent(questions, { tui, theme, done });
            });

            if (result.cancelled) {
                ctx.abort();
                return {
                    content: [{ type: "text", text: "User cancelled the questions" }],
                    details: result,
                };
            }

            const answerLines = result.answers.map((a) => {
                const q = questions[a.questionIndex]!;
                if (a.customText) {
                    return `${q.header}: "${a.customText}"`;
                }
                if (a.selectedLabels.length === 0) {
                    return `${q.header}: (no answer)`;
                }
                return `${q.header}: ${a.selectedLabels.join(", ")}`;
            });

            return {
                content: [{ type: "text", text: answerLines.join("\n") }],
                details: result,
            };
        },

        renderCall: (args, theme) => renderCall(args, theme),
        renderResult: (result, _options, theme) => renderResult(result as AgentToolResult<AskQuestionsResult>, theme),
    });
}
