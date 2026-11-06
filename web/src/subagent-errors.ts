import type { SubagentItemView } from "./subagent-presentation.js";

export function subagentFailed(item: SubagentItemView): boolean {
	return item.phase === "failed" || item.phase === "cancelled";
}

export function subagentErrorKind(item: SubagentItemView) {
	const text = item.text ?? "";
	if (text.startsWith("Error: Subagent finished without a successful investigation step.")) return "noSteps";
	if (/ECONNREFUSED/i.test(text)) return "connection";
	if (/429|too many requests|rate.?limit/i.test(text)) return "rate";
	if (/ENOENT|no such file|not found|不存在/i.test(text)) return "missing";
	if (/EACCES|permission denied|无权|权限/i.test(text)) return "permission";
	if (/timeout|timed out|超时/i.test(text)) return "timeout";
	if (item.phase === "cancelled" || /abort|cancel|timeout|timed out|超时|取消/i.test(text)) return "interrupted";
	return "unknown";
}

export function subagentErrorGroups(items: SubagentItemView[]) {
	const groups = new Map<string, { kind: ReturnType<typeof subagentErrorKind>; items: SubagentItemView[] }>();
	for (const item of items.filter(subagentFailed)) {
		const kind = subagentErrorKind(item);
		const key = kind === "unknown" ? `${kind}:${item.text ?? ""}` : kind;
		const group = groups.get(key) ?? { kind, items: [] };
		group.items.push(item);
		groups.set(key, group);
	}
	return [...groups.values()];
}

export function subagentRetryArguments(items: SubagentItemView[], argumentsText: string, fullTask?: string): string {
	let question: unknown, originalTasks: Record<string, unknown>[] = [];
	try {
		const args = JSON.parse(argumentsText);
		question = args.question;
		if (Array.isArray(args.tasks)) originalTasks = args.tasks;
	} catch { /* Historical arguments may be incomplete. */ }
	const ids = (task: Record<string, unknown>) => Array.isArray(task.sourceIds) ? task.sourceIds.filter((id): id is string => typeof id === "string") : typeof task.sourceId === "string" ? [task.sourceId] : [];
	if (!originalTasks.length && items.length === 1 && typeof question === "string") {
		originalTasks = [{ task: question, ...(items[0].sources?.length ? { sourceIds: items[0].sources.map(source => source.id) } : { sourceId: items[0].sourceId }) }];
	}
	if (!originalTasks.length || originalTasks.some(task => !task || typeof task !== "object")) throw Error("Original task instructions are unavailable");
	const tasks = items.map(item => {
		const currentIds = item.sources?.length ? item.sources.map(source => source.id) : [item.sourceId];
		const indexed = item.taskIndex !== undefined ? originalTasks[item.taskIndex] : undefined;
		const combined = originalTasks.filter(task => typeof task.task === "string" && (item.task === task.task || item.task.endsWith(`\n\n${task.task}`)));
		const sameSource = originalTasks.filter(task => ids(task).join("\n") === currentIds.join("\n"));
		const original = indexed ?? (combined.length === 1 ? combined[0] : undefined) ?? (sameSource.length === 1 ? sameSource[0] : undefined);
		if (!original || typeof original.task !== "string") throw Error("Original task cannot be uniquely identified");
		const originalIds = original ? ids(original) : [];
		const task = original.task as string;
		if (typeof question !== "string") {
			if (items.length !== 1 || fullTask === undefined) throw Error("Original task context is unavailable");
			if (fullTask === task) question = task;
			else if (fullTask.endsWith(`\n\n${task}`)) question = fullTask.slice(0, -task.length - 2);
			else throw Error("Original task context cannot be uniquely identified");
		}
		const title = typeof original?.title === "string" ? original.title : item.title || task.slice(0, 120);
		const selectedIds = originalIds.length ? originalIds : currentIds;
		return { ...(item.sources?.length || item.title || typeof original?.title === "string" ? { title } : {}), ...(item.sources?.length || originalIds.length > 1 ? { sourceIds: selectedIds } : { sourceId: selectedIds[0] }), task };
	});
	return JSON.stringify({ action: "run", scope: "selected", ...(typeof question === "string" ? { question } : {}), tasks }, null, 2);
}
