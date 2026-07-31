/**
 * Types for the Ask User Questions tool
 */

export interface AnswerOption {
  label: string;
  description: string;
}

export interface Question {
  header: string;
  question: string;
  answers: AnswerOption[];
  multipleChoice: boolean;
}

export interface QuestionResult {
  questionIndex: number;
  header: string;
  selectedIndices: number[];
  selectedLabels: string[];
}

export interface AskQuestionsResult {
  questions: Question[];
  answers: QuestionResult[];
  cancelled: boolean;
}
