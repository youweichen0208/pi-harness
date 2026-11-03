import { expect, test } from "vitest";
import type { UiMessage } from "../../server/protocol.js";
import { messageTimeGaps } from "../../web/src/time-gaps.js";

test("labels user turns, not elapsed time inside assistant replies", () => {
	const at = new Date(2026, 8, 25, 3, 52).getTime();
	const messages = [
		{ id: "1", role: "assistant", timestamp: at, content: [] },
		{ id: "2", role: "toolResult", timestamp: at + 3_000_000, content: [] },
		{ id: "3", role: "assistant", timestamp: at + 30 * 60_000, content: [] },
		{ id: "4", role: "user", timestamp: at + 61 * 60_000, content: [] },
	] as UiMessage[];
	expect([...messageTimeGaps(messages)]).toEqual([[3, "04:53"]]);
});

test("shows a single time for each user turn, excluding automatic reminders", () => {
	const at = new Date(2026, 10, 3, 10, 39).getTime();
	const messages: UiMessage[] = [
		{ id: "user", role: "user", timestamp: at, content: [] },
		{ id: "assistant", role: "assistant", timestamp: at + 1000, content: [] },
		{ id: "tool", role: "toolResult", timestamp: at + 2000, content: [] },
		{ id: "reminder", role: "user", origin: "auto-reminder", timestamp: at + 3000, content: [] },
		{ id: "next", role: "user", timestamp: at + 60000, content: [] },
	];
	expect([...messageTimeGaps(messages)]).toEqual([[0, "10:39"], [4, "10:40"]]);
});
