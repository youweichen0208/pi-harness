import { useSyncExternalStore } from "react";
import { OTHER_ANSWER, recommendedAnswers, type QuestionCard } from "./question-cards";

/** The newest reply's questions and the user's picks, shared by the cards and the answer bar (4a). */
export interface QuestionAnswerState {
	active: { key: string; conversationId: string; questions: QuestionCard[] } | null;
	answers: Record<string, number>;
	/** Text typed into each card's "其他" row. */
	custom: Record<string, string>;
	/** Epoch ms of the latest 全部采纳推荐 click, so the button always gives visible feedback. */
	acceptedAt?: number;
}

let state: QuestionAnswerState = { active: null, answers: {}, custom: {} };
const picks = new Map<string, Record<string, number>>();
const written = new Map<string, Record<string, string>>();
const listeners = new Set<() => void>();
const emit = (next: QuestionAnswerState) => { state = next; for (const listener of listeners) listener(); };

/** Only the latest settled reply registers; the returned cleanup releases it. */
export function registerQuestions(key: string, conversationId: string, questions: QuestionCard[]) {
	if (!picks.has(key)) picks.set(key, recommendedAnswers(questions));
	emit({ active: { key, conversationId, questions }, answers: picks.get(key)!, custom: written.get(key) ?? {} });
	return () => { if (state.active?.key === key) emit({ active: null, answers: {}, custom: {} }); };
}

export function choose(key: string, questionId: string, index: number) {
	const current = picks.get(key) ?? {};
	const next = { ...current };
	if (next[questionId] === index) delete next[questionId]; else next[questionId] = index;
	picks.set(key, next);
	if (state.active?.key === key) emit({ ...state, answers: next });
}

/** Typing into "其他" selects it; clearing the text keeps the selection so the row stays open. */
export function writeOther(key: string, questionId: string, text: string) {
	const custom = { ...written.get(key), [questionId]: text };
	const answers = { ...picks.get(key), [questionId]: OTHER_ANSWER };
	written.set(key, custom);
	picks.set(key, answers);
	if (state.active?.key === key) emit({ ...state, answers, custom });
}

export function selectOther(key: string, questionId: string) {
	const answers = { ...picks.get(key), [questionId]: OTHER_ANSWER };
	picks.set(key, answers);
	if (state.active?.key === key) emit({ ...state, answers });
}

export function acceptRecommended(key: string) {
	if (state.active?.key !== key) return;
	const next = { ...picks.get(key), ...recommendedAnswers(state.active.questions) };
	picks.set(key, next);
	emit({ ...state, answers: next, acceptedAt: Date.now() });
}

export function useQuestionAnswers() {
	return useSyncExternalStore(listener => { listeners.add(listener); return () => listeners.delete(listener); }, () => state);
}

/** Picks for a reply that is no longer the active one (read-only cards). */
export function answersFor(key: string): Record<string, number> | undefined {
	return picks.get(key);
}

export function customFor(key: string): Record<string, string> | undefined {
	return written.get(key);
}
