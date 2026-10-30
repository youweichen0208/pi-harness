/** Compatibility projection for ACP extensions that inject notifications with
 * sendUserMessage rather than a native custom message. Never changes LLM input. */
export function parseDelegateNotification(text: string): { agent: string; runId: string; status: "failed" | "completed" } | undefined {
	if (!text.includes("This is an automated system notification, NOT a user message.")) return;
	const match = /^\[acp_delegate (FAILED ⚠️|completed)\] (?:\*\*)?([^\n*]+?)(?:\*\*)? \(runId `?(del_[a-zA-Z0-9_]+)`?, exit (?:\?|\d+)[^\n)]*\)/.exec(text);
	if (!match) return;
	return { agent: match[2], runId: match[3], status: match[1] === "completed" ? "completed" : "failed" };
}
