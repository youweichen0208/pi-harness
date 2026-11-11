import { isToolTextContinuation } from "./tool-text.js";
import { taskFailed, unrecoveredFailures } from "./task-recovery.js";
import type { TaskProgress, TaskStep, UiMessage, UiToolCallBlock } from "./protocol.js";

export { taskFailed, unrecoveredFailures };

const short = (text: string, limit: number) => {
	const first = text.trim().replace(/\s+/g, " ").split(/[。！？\n]/)[0]?.trim() ?? "";
	return first.length > limit ? `${first.slice(0, limit)}…` : first;
};

const continuation = /^(?:继续(?:吧|吗)?|可以(?:的|吧|了)?|好的?|开始|接着|可以(?:帮我)?继续(?:吗|吧)?|帮我继续(?:吗|吧)?|please continue|continue)[\s，。！!？?]*$/i;
const nextStep = /^(?:(?:可以|能)?(?:帮我)?(?:开始|继续|接着|进行)(?:下一步|下个阶段|后续工作)?(?:吗|吧|了)?|下一步(?:呢|是什么)?)[\s，。！!？?]*$/i;
const optionReply = /^(?:[1-9]\d?|[A-D])(?:[.、)）])?[\s。！!]*$/i;
const vagueRequest = (text: string) => continuation.test(text.trim()) || nextStep.test(text.trim()) || optionReply.test(text.trim());
const greeting = /^(?:hi|hello|hey|你好|嗨|在吗|谢谢)[\s，。！!？?]*$/i;

function taskTitle(messages: UiMessage[], userIndex: number, steps: TaskStep[]): string {
	const textOf = (message: UiMessage) => message.content.map((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : "").join(" ");
	const current = textOf(messages[userIndex]);
	if (vagueRequest(current)) {
		for (let index = userIndex - 1; index >= 0; index--) {
			if (messages[index].role !== "user" || isToolTextContinuation(messages, index)) continue;
			const previous = textOf(messages[index]);
			if (!vagueRequest(previous) && !greeting.test(previous.trim()) && previous.trim()) return short(previous, 56);
		}
		const firstAction = steps.find((step) => step.title && step.title !== "正在分析请求");
		if (firstAction) return short(firstAction.title, 56);
	}
	return short(current, 56) || "当前任务";
}

function artifact(call: UiToolCallBlock): TaskStep["artifacts"][number] {
	let args: Record<string, unknown> = {};
	try { args = JSON.parse(call.argumentsText ?? "{}") as Record<string, unknown>; } catch { /* keep tool name */ }
	const path = typeof args.path === "string" ? args.path : undefined;
	const command = typeof args.command === "string" ? args.command : undefined;
	// The command row is read back on demand, so keep the whole command (one line,
	// no sentence splitting) instead of the 78-character display summary.
	const commandLabel = command?.replace(/\s+/g, " ").trim().slice(0, 400);
	return { toolCallId: call.id, kind: call.name, label: path ?? (commandLabel ? commandLabel : call.name), ...(path ? { path } : {}) };
}

function defaultTitle(calls: UiToolCallBlock[]): string {
	if (calls.length === 1) {
		const item = artifact(calls[0]);
		return item.kind === "bash" ? `运行 ${item.label}` : item.path ? `${item.kind} ${item.label}` : item.label;
	}
	const name = calls.every((call) => call.name === calls[0].name) ? calls[0].name : "工具";
	return `${name === "read" ? "读取" : name === "write" ? "写入" : name === "bash" ? "运行" : name} ${calls.length} 项`;
}

/** P0: infer the current task from the server's serialized transcript. The
 * transcript remains authoritative; no browser heuristic decides completion. */
export function deriveTaskProgress(conversationId: string, messages: UiMessage[], streamingMessage: UiMessage | null, isStreaming: boolean, turnEndedAt?: number): TaskProgress | null {
	const latestUserIndex = messages.findLastIndex((message, index) => message.role === "user" && !isToolTextContinuation(messages, index) && message.content.some((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string"));
	if (latestUserIndex < 0) return null;
	const userIndex = latestUserIndex;
	const user = messages[userIndex];
	const tail = [...messages.slice(userIndex + 1), ...(streamingMessage?.role === "assistant" ? [streamingMessage] : [])];
	// A plain conversation is not a task. Create the panel only after pi has
	// actually invoked a tool in this turn.
	if (!tail.some((message) => message.role === "assistant" && message.content.some((part) => part.type === "toolCall"))) return null;
	const results = new Map(tail.filter((message) => message.role === "toolResult" && message.toolCallId).map((message) => [message.toolCallId!, message]));
	const steps: TaskStep[] = [];
	for (const message of tail) {
		if (message.role !== "assistant") continue;
		let narrative = "";
		let calls: UiToolCallBlock[] = [];
		let group = 0;
		const flush = () => {
			if (!calls.length) return;
			// Once the turn settled, calls without results are over (interrupted
			// or never executed) — conclude them as failed, never as done.
			const unexecuted = !isStreaming && calls.some((call) => !results.has(call.id));
			const completed = calls.filter((call) => results.has(call.id) || !isStreaming).length;
			const failed = unexecuted || calls.some((call) => results.get(call.id)?.isError);
			const status: TaskStep["status"] = completed < calls.length ? "running" : failed ? "failed" : "done";
			const endedAt = Math.max(message.timestamp ?? 0, ...calls.map((call) => results.get(call.id)?.timestamp ?? 0));
			steps.push({ id: `${message.id}:${group++}`, messageId: message.id, title: short(narrative, 24) || defaultTitle(calls), status, startedAt: message.timestamp ?? user.timestamp ?? 0, ...(status !== "running" ? { endedAt } : {}), hint: status === "running" ? `${completed}/${calls.length} 项完成` : unexecuted ? "有工具未执行" : failed ? "有工具执行失败" : `${calls.length} 项完成`, artifacts: calls.map((call) => {
				const item = artifact(call);
				const output = results.get(call.id)?.content.filter((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => (part as { text: string }).text).join("\n");
				const outputLines = output ? output.replace(/\n$/, "").split("\n").length : 0;
				return outputLines && ["bash", "read"].includes(item.kind) ? { ...item, outputLines } : item;
			}) });
			calls = [];
			narrative = "";
		};
		for (const part of message.content) {
			if (part.type === "toolCall" && typeof (part as UiToolCallBlock).id === "string") calls.push(part as UiToolCallBlock);
			else if (part.type === "text" && typeof (part as { text?: unknown }).text === "string") { flush(); narrative = (part as { text: string }).text; }
		}
		flush();
	}
	if (isStreaming && !steps.some((step) => step.status === "running")) {
		const previous = [...tail].reverse().find((message) => message.role === "assistant");
		steps.push({ id: `${user.id}:pending`, messageId: previous?.id ?? user.id, title: "正在分析请求", status: "running", startedAt: previous?.timestamp ?? user.timestamp ?? 0, artifacts: [] });
	}
	const currentTail = messages.slice(latestUserIndex + 1).concat(streamingMessage ? [streamingMessage] : []);
	const outputLimited = currentTail.findLast(message => message.role === "assistant")?.stopReason === "length";
	const cancelled = currentTail.some((message) => message.role === "assistant" && message.stopReason === "aborted");
	// Earlier failed commands can be followed by a successful fix or rerun, so the
	// outcome is decided by the same recovery rule the step list uses.
	const status: TaskProgress["status"] = cancelled ? "cancelled" : isStreaming ? "running" : outputLimited || taskFailed(steps) ? "failed" : "done";
	if (!steps.length) return null;
	const title = taskTitle(messages, userIndex, steps);
	const endedAt = status === "running" ? undefined : Math.max(user.timestamp ?? 0, turnEndedAt ?? 0, ...tail.map((message) => message.timestamp ?? 0), ...steps.map((step) => step.endedAt ?? 0));
	return { id: `task:${user.id}`, conversationId, sourceMessageId: user.id, title, status, startedAt: user.timestamp ?? 0, ...(endedAt ? { endedAt } : {}), completed: steps.filter((step) => step.status === "done").length, steps };
}
