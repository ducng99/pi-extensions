/**
 * TypeBox schemas for the Ask User Questions tool
 */

import { Type } from "typebox";

import type { AnswerOption, Question } from "./types";

const AnswerOptionSchema = Type.Object({
    label: Type.String({ description: "Short label for the answer option" }),
    description: Type.String({ description: "Description explaining the answer" }),
});

const QuestionSchema = Type.Object({
    header: Type.String({
        description: "Short 1-3 word header for the tab, describing what the question is about",
        minLength: 1,
        maxLength: 30,
    }),
    question: Type.String({
        description: "The full question text to display to the user",
    }),
    answers: Type.Optional(Type.Array(AnswerOptionSchema, {
        description: "Pre-generated answer options (1-5 options)",
        minItems: 1,
        maxItems: 5,
    })),
    options: Type.Optional(Type.Array(AnswerOptionSchema, {
        description: "Alias for answers",
        minItems: 1,
        maxItems: 5,
    })),
    multipleChoice: Type.Boolean({
        description: "If true, user can select multiple answers (checkboxes). If false, single choice (radio).",
    }),
});

export const AskQuestionsParams = Type.Object({
    questions: Type.Array(QuestionSchema, {
        description: "Questions to ask the user (1-5 questions)",
        minItems: 1,
        maxItems: 5,
    }),
});

export function normalizeQuestion(question: {
    header: string;
    question: string;
    answers?: AnswerOption[];
    options?: AnswerOption[];
    multipleChoice: boolean;
}): Question | null {
    const answers = question.answers ?? question.options;
    if (!answers || answers.length === 0) return null;
    return { header: question.header, question: question.question, answers, multipleChoice: question.multipleChoice };
}
