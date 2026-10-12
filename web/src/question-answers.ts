import { useSyncExternalStore } from "react";
import { recommendedAnswers, type QuestionCard } from "./question-cards";

/** The newest reply's questions and the user's picks, shared by the cards and the answer bar (4a). */
export interface QuestionAnswerState {
	active: { key: string; conversationId: string; questions: QuestionCard[] } | null;
	answers: Record<string, number>;
}

let state: QuestionAnswerState = { active: null, answers: {} };
const picks = new Map<string, Record<string, number>>();
const listeners = new Set<() => void>();
const emit = (next: QuestionAnswerState) => { state = next; for (const listener of listeners) listener(); };

/** Only the latest settled reply registers; the returned cleanup releases it. */
export function registerQuestions(key: string, conversationId: string, questions: QuestionCard[]) {
	if (!picks.has(key)) picks.set(key, recommendedAnswers(questions));
	emit({ active: { key, conversationId, questions }, answers: picks.get(key)! });
	return () => { if (state.active?.key === key) emit({ active: null, answers: {} }); };
}

export function choose(key: string, questionId: string, index: number) {
	const current = picks.get(key) ?? {};
	const next = { ...current };
	if (next[questionId] === index) delete next[questionId]; else next[questionId] = index;
	picks.set(key, next);
	if (state.active?.key === key) emit({ ...state, answers: next });
}

export function acceptRecommended(key: string) {
	if (state.active?.key !== key) return;
	const next = { ...picks.get(key), ...recommendedAnswers(state.active.questions) };
	picks.set(key, next);
	emit({ ...state, answers: next });
}

export function useQuestionAnswers() {
	return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => state);
}

/** Picks for a reply that is no longer the active one (read-only cards). */
export function answersFor(key: string): Record<string, number> | undefined {
	return picks.get(key);
}
