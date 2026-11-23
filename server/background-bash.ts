import { StringDecoder } from "node:string_decoder";
import { Type } from "typebox";
import { createBashToolDefinition, createLocalBashOperations, type ExtensionFactory, type SessionManager, type SettingsManager } from "@earendil-works/pi-coding-agent";
import { getDocumentSettings } from "./document-extension-settings.js";
import type { BackgroundCommand } from "./protocol.js";

const registry = new WeakMap<SessionManager, Map<string, Task>>();
const recordType = "pi-harness:background-command";
interface Task {
	view: BackgroundCommand;
	request?: string;
	detach(): void;
	stop(): void;
	pending: boolean;
	suppressDelivery?: boolean;
	marker?: string;
	finished?: Promise<unknown>;
}
const currentRequest = (session: SessionManager) => session.getBranch().findLast(entry => entry.type === "message" && entry.message.role === "user")?.id;
export function commandViews(session: SessionManager) {
	return Array.from(registry.get(session)?.values() ?? [], task => ({ ...task.view }));
}
export function hasRunningCommand(session: SessionManager) {
	for (const task of registry.get(session)?.values() ?? []) {
		if (task.pending || task.view.state === "foreground" || task.view.state === "background") return true;
	}
	return false;
}
export function controlCommand(session: SessionManager, id: string, action: "detach" | "stop") {
	const task = registry.get(session)?.get(id);
	if (action === "detach") task?.detach();
	if (action === "stop") task?.stop();
}
export function stopRequestCommands(session: SessionManager) {
	const request = currentRequest(session);
	for (const task of registry.get(session)?.values() ?? []) if (task.request === request) task.stop();
}
const backgroundNote = "Running in the background. Completion will be delivered automatically on this conversation branch. Continue other work; do not poll. Silence alone does not indicate a hung command.";
function taskReport(task: Task, cursor?: number) {
	const v = task.view;
	const willNotify = v.state === "background" && !task.suppressDelivery;
	return {
		...v,
		output: v.output.slice(Math.max(0, (cursor ?? 0) - v.cursor + v.output.length)),
		elapsedMs: Math.max(0, (v.endedAt ?? Date.now()) - v.startedAt),
		lastOutputAtMs: v.lastOutputAtMs ?? null,
		...(cursor === undefined ? {} : { unchanged: cursor === v.cursor }),
		willNotify,
		...(willNotify ? { note: backgroundNote } : {}),
	};
}
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined });

export function backgroundBash(session: SessionManager, settings: SettingsManager, changed: () => void, trace: (view: BackgroundCommand) => void): ExtensionFactory {
	return pi => {
		const tasks = new Map<string, Task>();
		let closed = false;
		let notify: ReturnType<typeof setTimeout> | undefined;
		pi.on("session_start", () => {
			registry.set(session, tasks);
			for (const entry of session.getBranch()) {
				if (entry.type !== "custom" || entry.customType !== recordType) continue;
				const view = entry.data as BackgroundCommand;
				if (!view?.id) continue;
				tasks.set(view.id, { view: { ...view, state: view.state === "background" ? "interrupted" : view.state }, pending: false, detach() {}, stop() {} });
			}
		});
		pi.on("session_shutdown", async () => {
			closed = true;
			clearTimeout(notify);
			for (const task of tasks.values()) task.stop();
			await Promise.allSettled([...tasks.values()].map(task => task.finished));
			if (registry.get(session) === tasks) registry.delete(session);
		});
		if (!getDocumentSettings().backgroundEnabled) return;
		pi.on("session_tree", () => {
			for (const task of tasks.values()) {
				task.suppressDelivery = true;
				task.pending = false;
			}
		});
		const takeResults = () => {
			if (![...tasks.values()].some(t => t.pending)) return;
			const branch = new Set(session.getBranch().map(entry => entry.id));
			const ready = [...tasks.values()].filter(task => task.pending && task.marker && branch.has(task.marker));
			if (!ready.length) return;
			for (const task of ready) task.pending = false;
			return { type: "custom_message" as const, customType: "background-results", content: JSON.stringify(ready.map(task => ({
				...task.view, originatingUserEntryId: task.request,
			}))), details: {}, display: false };
		};
		const deliver = (event: { outcome: string }, ctx: { hasPendingMessages(): boolean }) => {
			if (event.outcome === "aborted" || ctx.hasPendingMessages()) return;
			const message = takeResults();
			if (message) return { entries: [message], continue: true };
		};
		pi.on("turn_end", deliver);
		pi.on("agent_before_settle", deliver);
		const scheduleIdleDelivery = (ctx: { isIdle(): boolean }) => {
			if (notify || closed) return;
			notify = setTimeout(() => {
				notify = undefined;
				if (!ctx.isIdle() || closed) return;
				const message = takeResults();
				if (message) pi.sendMessage(message, { triggerTurn: true });
			}, 25);
		};
		pi.on("agent_settled", (event, ctx) => {
			if (event.aborted) stopRequestCommands(session);
			else if ([...tasks.values()].some(task => task.pending)) scheduleIdleDelivery(ctx);
		});
		const options = { shellPath: settings.getShellPath(), commandPrefix: settings.getShellCommandPrefix() };
		const native = createBashToolDefinition(session.getCwd(), options);
		pi.registerTool({
			...native,
			// Inherit the native Bash loadout, including configurations that omit Bash.
			defaultActive: false,
			parameters: Type.Object({ ...native.parameters.properties, background: Type.Optional(Type.Boolean({ description: "Run in the background and return a task ID immediately. Completion is delivered automatically; do not poll." })) }),
			async execute(id, args, signal, update, ctx) {
				if (id.includes("/")) return native.execute(id, args, signal, update, ctx);
				const controller = new AbortController();
				const abort = () => controller.abort();
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
				const view: BackgroundCommand = { id, state: "foreground", startedAt: Date.now(), output: "", cursor: 0 };
				let release!: () => void;
				const detached = new Promise<void>(resolve => { release = resolve; });
				const task: Task = {
					view, request: currentRequest(session), pending: false,
					detach() {
						if (view.state !== "foreground" || controller.signal.aborted) return;
						view.state = "background";
						view.detachedAt = Date.now();
						signal?.removeEventListener("abort", abort);
						task.marker = session.appendCustomEntry(recordType, { ...view });
						trace(view);
						release();
						changed();
					},
					stop() { task.pending = false; controller.abort(); },
				};
				tasks.set(id, task);
				changed();
				const timer = setTimeout(task.detach, 30_000);
				const decoder = new StringDecoder("utf8");
				const ops = createLocalBashOperations(options);
				const tool = createBashToolDefinition(ctx.cwd, { ...options, operations: {
					exec: (cmd, cwd, opts) => ops.exec(cmd, cwd, { ...opts, onData(chunk) {
						if (chunk.length) view.lastOutputAtMs = Date.now();
						const text = decoder.write(chunk);
						view.output = (view.output + text).slice(-51200);
						view.cursor += text.length;
						opts.onData(chunk);
					} }),
				} });
				const finish = (failed: boolean, error?: string) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", abort);
					const detached = view.state === "background";
					view.endedAt = Date.now();
					view.state = controller.signal.aborted ? "stopped" : failed ? "failed" : "done";
					if (!detached) tasks.delete(id);
					else {
						if (error && !closed) view.error = error.slice(-1024);
						trace(view);
						const onBranch = session.getBranch().some(entry => entry.id === task.marker);
						if (onBranch) session.appendCustomEntry(recordType, { ...view });
						task.pending = onBranch && !closed && !controller.signal.aborted && !task.suppressDelivery;
						if (task.pending) scheduleIdleDelivery(ctx);
					}
					if (!closed) changed();
					task.finished = undefined;
				};
				const execution = tool.execute(id, args, controller.signal, result => {
					view.fullOutputPath = result.details?.fullOutputPath;
					if (view.state === "foreground") update?.(result);
					else changed();
				}, ctx).then(result => {
					view.exitCode = (result.structuredContent as { exit_code?: number })?.exit_code;
					view.fullOutputPath = result.details?.fullOutputPath;
					finish(!!result.isError);
					return result;
				}, error => { finish(true, String(error)); throw error; });
				task.finished = execution.then(() => undefined, () => undefined);
				if (args.background) task.detach();
				return Promise.race([execution, detached.then(() => reply(taskReport(task)))]);
			},
		});
		pi.registerTool({
			name: "bash_task", label: "Background commands", description: "Background commands report completion automatically. Do not poll. Read only when intermediate output is needed; pass the previous cursor for changes. Stop only when cancellation is intended.",
			parameters: Type.Object({ action: Type.Union([Type.Literal("list"), Type.Literal("read"), Type.Literal("stop")]), id: Type.Optional(Type.String()), cursor: Type.Optional(Type.Integer({minimum: 0})) }),
			async execute(_id, args) {
				if (args.action === "list") return reply([...tasks.values()].map(({view}) => ({ id: view.id, state: view.state })));
				const task = tasks.get(args.id ?? "");
				if (!task) throw Error("Unknown command");
				if (args.action === "stop") {
					task.stop();
					await task.finished;
				}
				// An explicit read of the completed result already delivers it to the model.
				if (task.view.endedAt !== undefined) task.pending = false;
				return reply(taskReport(task, args.cursor));
			},
		});
	};
}
