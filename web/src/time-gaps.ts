import type { UiMessage } from "../../server/protocol.js";

/** One local-time label per user turn; automatic reminders stay in their original turn. */
export function messageTimeGaps(messages: readonly UiMessage[]): Map<number, string> {
	const gaps = new Map<number, string>();
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (message.role !== "user" || message.origin === "auto-reminder" || !message.timestamp) continue;
		const date = new Date(message.timestamp);
		gaps.set(index, `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`);
	}
	return gaps;
}
