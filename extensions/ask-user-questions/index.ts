/**
 * Ask User Questions Tool
 *
 * Replicates Claude Code's AskUserQuestion tool.
 * Asks the user 1-5 questions, each rendered as a tab.
 * Supports single-choice (radio) and multi-choice (checkbox) per question.
 * Final tab is a review/submit summary.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createQuestionsComponent } from "./component.js";
import { renderCall, renderResult } from "./renderer.js";
import { AskQuestionsParams } from "./schema.js";
import type { AskQuestionsResult, Question } from "./types.js";

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
        label: "Ask User",
        description:
      "Ask the user up to 5 clarifying questions. Each question has pre-generated answer options shown as checkboxes (multi-select) or radio buttons (single-select)",
        promptSnippet:
      "Ask the user 1-5 multiple-choice or single-choice questions with pre-generated answers",
        promptGuidelines: [
            "Use ask_user_questions when you need to clarify requirements, confirm decisions, or get user preferences before proceeding.",
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
        renderResult: (result, _options, theme) => renderResult(result, theme),
    });
}
