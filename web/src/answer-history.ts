import type { UiMessage } from "../../server/protocol.js";

/** Read the answer bar's plain-text format without changing the saved prompt. */
export function parseAnswerSummary(text: string) {
	const lines = text.trim().split(/\r?\n/);
	const items: { id: string; title: string; answer: string }[] = [];
	while (lines.length) {
		const match = /^(Q\d+)(?:\s+([^：\n]+))?：(.+)$/.exec(lines[0]);
		if (!match || items.some(item => item.id === match[1])) break;
		items.push({ id: match[1], title: match[2] ?? "", answer: match[3] });
		lines.shift();
	}
	return items.length >= 2 ? { items, note: lines.join("\n").trim() } : null;
}

export function answerHistory(messages: readonly UiMessage[]) {
	const rounds: UiMessage[][] = [];
	let current: UiMessage[] | undefined;
	for (const message of messages) {
		if (message.role === "user" && message.origin !== "auto-reminder") {
			const text = message.questionText ?? message.content.map(block => block.type === "text" ? block.text : "").join("\n");
			current = parseAnswerSummary(text) ? [] : undefined;
			if (current) rounds.push(current);
		}
		current?.push(message);
	}
	const protectedIds = new Set(rounds.flatMap(round => round.map(message => message.id)));
	const groups: { ids: string[]; count: number }[] = [];
	for (const round of rounds.slice(0, -2)) {
		const last = groups.at(-1);
		const index = messages.indexOf(round[0]);
		if (last && index > 0 && last.ids.at(-1) === messages[index - 1].id) {
			last.ids.push(...round.map(message => message.id));
			last.count++;
		} else groups.push({ ids: round.map(message => message.id), count: 1 });
	}
	return { protectedIds, groups };
}
