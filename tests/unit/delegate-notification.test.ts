import { expect, test } from "vitest";
import { serializeMessage, type AgentMessage } from "../../server/serialize.js";

const notification = "[acp_delegate FAILED ⚠️] researcher (runId del_mvqe9kh7_2098, exit ?) No delegates are currently running. This delegate did NOT complete its task — its result is missing from your work. Read the error excerpt (and the result file if present), then decide whether to re-dispatch the task before wrapping up. This is an automated system notification, NOT a user message.";
const message = (text: string): Extract<AgentMessage, { role: "user" }> => ({ role: "user", content: [{ type: "text", text }], timestamp: 123 });

test("issue 137 notification is an extension event with preserved diagnostics", () => {
	const original = message(notification);
	const projected = serializeMessage(original, 1);
	expect(projected).toMatchObject({ role: "custom", customType: "acp-delegate", details: { agent: "researcher", runId: "del_mvqe9kh7_2098", status: "failed" } });
	expect(projected?.content).toEqual(original.content);
	expect(original.role).toBe("user");
});

test("native Markdown notification headers and completed status are supported", () => {
	const text = notification.replace("FAILED ⚠️", "completed").replace("researcher", "**researcher**").replace("del_mvqe9kh7_2098,", "`del_mvqe9kh7_2098`,") + "\nResult: /tmp/report.md";
	expect(serializeMessage(message(text), 1)).toMatchObject({ role: "custom", details: { status: "completed" }, content: [{ type: "text", text }] });
});

test("quoted notifications, ordinary discussion and attachments remain user messages", () => {
	for (const text of ["Why does this appear?\n" + notification, "> " + notification, notification.replace("del_mvqe9kh7_2098", "unknown"), notification.split("This is an automated")[0]]) {
		expect(serializeMessage(message(text), 1)?.role).toBe("user");
	}
	const attached: AgentMessage = { role: "user", timestamp: 123, content: [{ type: "text", text: notification }, { type: "image", data: "AAAA", mimeType: "image/png" }] };
	expect(serializeMessage(attached, 1)?.role).toBe("user");
});
