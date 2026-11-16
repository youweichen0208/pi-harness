import type { UiMessage, UiState, UiRecovery, UiSessionPersistence } from "../protocol.js";
import { writesSession } from "./persistence.js";
import { ageRecovery } from "./recovery.js";
import { isRecord } from "./framing.js";
import { OmpHostTools, type HostTool } from "./host-tools.js";
import { projectMessage, projectModel, type OmpModel } from "./presentation.js";
import { createOmpRuntime, stopOmpRuntime, readOmpTree, type OmpRuntimeOptions } from "./runtime.js";
import type { OmpEnvelope, OmpTransport, OmpFrame } from "./transport.js";
import { OmpTasks, taskMessagePage } from "./tasks.js";
import { createModelDiagnostics } from "../model-diagnostics.js";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { OmpPersistenceJournal } from "./persistence-journal.js";
import { ThinkingTimings, thinkingDurationsFor } from "../thinking-timing.js";
import { appendCommandOutput } from "./commands.js";

const REPETITION_INTERRUPTED = "OMP 检测到模型输出持续重复，本轮已中止；不会自动续跑。请检查历史后再手动继续。";
export const PERSISTENCE_FAILED = "OMP 无法确认历史已保存，本轮已停止。请先修复存储问题，再明确重新读取已保存历史；未保存的内容可能丢失，不会自动重发。";

export interface OmpSessionState {
	tree?: Omit<NonNullable<UiState["tree"]>, "busy" | "verifying" | "externallyModified">;
	cwdEvents?: UiState["cwdEvents"];
	commandOutputs?: UiState["commandOutputs"];
	persistence?: UiSessionPersistence;
	recovery?: UiRecovery;
	runSettings?: UiState["runSettings"];
	messages: UiMessage[];
	historyBytes: number;
	streaming?: UiMessage;
	models: OmpModel[];
	model?: OmpModel;
	thinking: string;
	running: boolean;
	sessionFile?: string;
	error?: string;
	interrupted: boolean;
	sessionId?: string;
	sessionName?: string;
	stats?: UiState["stats"];
	thinkingLevels?: string[];
	tools?: string[];
	queue?: { steering: string[]; followUp: string[] };
}
type Options = Omit<OmpRuntimeOptions, "onEvent" | "onExit" | "messageUpdates"> & {
	tools?: HostTool[];
	onChange(state: OmpSessionState): void;
	onEvent?(event: OmpEnvelope): void;
};
/** Product session, with OMP's RPC as authority. No Pi SDK or automatic prompt replay. */
export class OmpSession {
	private timings = new ThinkingTimings();
	private projectMessage(value: unknown, index: number, entryId?: string) {
		const timestamp = isRecord(value) && typeof value.timestamp === "number" ? value.timestamp : undefined;
		const durations = timestamp === undefined ? undefined : {
			...thinkingDurationsFor(join(this.options.dataDir, "omp/thinking-durations.json")).durations(this.state.sessionFile, timestamp),
			...this.timings.durations(timestamp),
		};
		return projectMessage(value, index, entryId, durations);
	}
	private tasks = new OmpTasks();
	taskSnapshot() { return this.tasks.visible(this.state.messages, this.state.streaming); }
	taskOutputPath(taskId: string) { return this.tasks.outputPath(taskId, this.state.messages, this.state.streaming); }
	async taskRequest(taskId: string, action: "detail" | "stop", cursor = 0) {
		const runtime = this.runtime;
		if (!runtime || this.stopping) throw Error("Task worker is unavailable");
		if (!Number.isSafeInteger(cursor) || cursor < 0) throw Error("Invalid task cursor");
		const task = this.tasks.resolve(taskId, runtime.generation, this.state.messages, this.state.streaming);
		if (action === "stop") {
			if (task.historical) return { task: { ...task.view }, cancelled: false };
			const roster = await runtime.request("get_subagents");
			this.tasks.resolve(taskId, this.runtime?.generation, this.state.messages, this.state.streaming);
			if (!isRecord(roster.data) || !Array.isArray(roster.data.subagents)) throw Error("Invalid native task roster");
			const owned = roster.data.subagents.some(item => isRecord(item) && item.id === task.nativeId && item.parentToolCallId === task.view.parentToolCallId && (item.status === "running" || item.status === "pending"));
			if (!owned) return { task: { ...task.view }, cancelled: false };
			const result = await runtime.request("cancel_subagent", { subagentId: task.nativeId });
			if (!isRecord(result.data) || typeof result.data.cancelled !== "boolean") throw Error("Invalid native cancellation response");
			return { task: { ...task.view }, cancelled: result.data.cancelled };
		}
		if (task.historyHandle && !task.view.canStop) {
			const result = await runtime.request("harness_task_history", { handle: task.historyHandle, cursor });
			this.tasks.resolve(taskId, this.runtime?.generation, this.state.messages, this.state.streaming);
			if (!isRecord(result.data) || !Array.isArray(result.data.messages)) throw Error("Invalid native task history");
			return { task: { ...task.view }, messages: result.data.messages as UiMessage[], nextCursor: result.data.nextCursor as number, hasMore: result.data.hasMore === true, truncated: result.data.truncated === true };
		}
		const result = await runtime.request("get_subagent_messages", { subagentId: task.nativeId });
		this.tasks.resolve(taskId, this.runtime?.generation, this.state.messages, this.state.streaming);
		if (!isRecord(result.data) || !Array.isArray(result.data.messages)) throw Error("Invalid native task transcript");
		if (cursor > result.data.messages.length) throw Error("Task transcript changed; reload its first page");
		return { task: { ...task.view }, ...taskMessagePage(result.data.messages, cursor) };
	}
	private recoveryRevision = 0;
	private recoveryUpdatedAt = 0;
	private activityRevision = 0;
	private runOverrides: { autoCompaction?: boolean; autoRetry?: boolean } = {};
	recoverySnapshot() { return ageRecovery(this.state.recovery, performance.now() - this.recoveryUpdatedAt); }
	private receiveRecovery(recovery: Record<string, unknown>) {
		this.state.recovery = recovery as UiRecovery;
		this.recoveryUpdatedAt = performance.now();
	}
	async cancelRecovery(operationId: string) {
		if (!this.runtime || this.stopping) throw Error("Recovery operation is no longer active");
		const response = await this.runtime.request("harness_cancel_recovery", { operationId });
		if (!isRecord(response.data) || response.data.cancelled !== true) throw Error("Recovery operation is no longer active");
	}
	async setRunSettings(settings: { autoCompaction?: boolean; autoRetry?: boolean }) {
		for (const key of ["autoCompaction", "autoRetry"] as const) {
			if (settings[key] === undefined) continue;
			if (typeof settings[key] !== "boolean") throw Error("Invalid run setting");
			await this.command(key === "autoCompaction" ? "set_auto_compaction" : "set_auto_retry", { enabled: settings[key] });
			this.runOverrides[key] = settings[key];
		}
		await this.refresh();
	}
	private queueRevision = 0;
	private updateQueue(queue: Record<string, unknown>) {
		const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
		const live = typeof queue.liveSteered === "number" && Number.isSafeInteger(queue.liveSteered) && queue.liveSteered > 0 ? queue.liveSteered : 0;
		const preview = (text: string) => text.length > 2000 ? text.slice(0, 2000) + "…" : text;
		this.state.queue = { steering: strings(queue.steering).slice(live).map(preview), followUp: strings(queue.followUp).map(preview) };
	}
	private inputTail: Promise<unknown> = Promise.resolve();
	private inputEpoch = 0;
	private pendingInputs = 0;
	private orderedInput<T>(action: () => Promise<T>): Promise<T> {
		this.pendingInputs++;
		const epoch = this.inputEpoch;
		const pending = this.inputTail.then(() => {
			if (epoch !== this.inputEpoch) throw Error("Input cancelled by Stop");
			return action();
		});
		this.inputTail = pending.catch(() => {});
		return pending.finally(() => { this.pendingInputs--; });
	}
	/** Serialize admission with recall so clearQueue cannot overtake an RPC steer. */
	submit(message: string, images: { type: "image"; data: string; mimeType: string }[], behavior: "steer" | "followUp", onPromptResult?: (frame: OmpFrame) => void) {
		return this.orderedInput(async () => {
			// Native prompt dispatch owns skill/command/template expansion before queue admission.
			if (!this.state.running) return this.prompt(message, images, onPromptResult);
			const response = await this.command("prompt", { message, images, streamingBehavior: behavior }, { onPromptResult });
			return isRecord(response.data) && response.data.agentInvoked === false;
		});
	}
	recallQueue() {
		return this.orderedInput(async () => {
			const response = await this.command("harness_recall_queue");
			if (!isRecord(response.data) || !Array.isArray(response.data.steering) || !Array.isArray(response.data.followUp)) throw Error("Invalid native queue response");
			const texts: string[] = [], images: { data: string; mimeType: string }[] = [];
			for (const entry of [...response.data.steering, ...response.data.followUp]) {
				if (!isRecord(entry) || typeof entry.text !== "string") throw Error("Invalid native queue entry");
				texts.push(entry.text);
				if (Array.isArray(entry.images)) for (const image of entry.images) {
					if (!isRecord(image) || typeof image.data !== "string" || typeof image.mimeType !== "string") throw Error("Invalid native queue image");
					images.push({ data: image.data, mimeType: image.mimeType });
				}
			}
			return { text: texts.join("\n\n"), images };
		});
	}
	private static live = new Set<OmpSession>();
	static async refreshCredentials(dataDir: string) {
		await Promise.allSettled([...OmpSession.live].filter(session => session.options.dataDir === dataDir && session.runtime && !session.state.running && !session.closed).map(session => session.refresh()));
	}
	readonly state: OmpSessionState = { messages: [], historyBytes: 0, models: [], thinking: "off", running: false, interrupted: false };
	private runtime?: OmpTransport;
	private hostTools?: OmpHostTools;
	private opening?: Promise<void>;
	private stopping?: Promise<void>;
	private closed = false;
	private refreshing?: Promise<void>;
	private revision = 0;
	private stoppedTree?: Record<string, unknown>;
	private stoppedLeaf?: string | null;
	private listeners = new Set<(event: OmpFrame) => void>();
	private selectedThinking?: OmpRuntimeOptions["thinking"];
	private metadata = new Map<string, OmpFrame>();
	private commandRevision = 0;
	get commandCatalog(): unknown[] {
		const data = this.metadata.get("get_available_commands")?.data;
		return isRecord(data) && Array.isArray(data.commands) ? data.commands : [];
	}
	private repetitionInterrupted = false;
	private mcpAuthPending = false;
	private persistenceFailed = false;
	private persistenceRevision = 0;
	private reopening = false;
	private journal: OmpPersistenceJournal;
	private recoveryTokens?: string[];
	private readPersistenceRestriction() {
		if (!this.state.sessionFile || this.reopening) return;
		const wasFailed = this.persistenceFailed;
		try {
			const restriction = this.journal.read(this.state.sessionFile);
			if (restriction.tokens.length) this.receivePersistence({ failed: true, externallyModified: restriction.externallyModified });
		} catch { this.receivePersistence({ failed: true, recoveryStateUnavailable: true }); }
		if (!wasFailed && this.persistenceFailed && this.runtime) {
			void this.stop().catch(() => {});
			this.changed();
		}
	}
	assertWritable() { this.readPersistenceRestriction(); if (this.persistenceFailed || this.reopening) throw Error(PERSISTENCE_FAILED); }
	private receivePersistence(value: unknown) {
		if (!isRecord(value) || typeof value.failed !== "boolean") return;
		this.persistenceFailed ||= value.failed;
		const relocation = value.relocation;
		const previous = this.state.persistence?.relocation;
		const next = isRecord(relocation) && ["open-elsewhere", "replaced", "contested"].includes(String(relocation.reason)) && typeof relocation.fromFile === "string" && typeof relocation.toFile === "string"
			? { reason: relocation.reason as NonNullable<UiSessionPersistence["relocation"]>["reason"], fromFile: relocation.fromFile, toFile: relocation.toFile } : previous;
		this.state.persistence = { failed: this.persistenceFailed, ...(next ? { relocation: next } : {}),
			...(this.persistenceFailed && (value.externallyModified === true || this.state.persistence?.externallyModified) ? { externallyModified: true } : {}),
			...(this.persistenceFailed && (value.recoveryStateUnavailable === true || this.state.persistence?.recoveryStateUnavailable) ? { recoveryStateUnavailable: true } : {}) };
		if (this.persistenceFailed) { this.state.interrupted = true; this.state.error = PERSISTENCE_FAILED; }
	}
	constructor(private readonly options: Options) {
		this.journal = new OmpPersistenceJournal(join(options.dataDir, "omp"));
		this.state.sessionFile = options.sessionFile;
		this.readPersistenceRestriction(); OmpSession.live.add(this);
	}
	readonly sessionManager = { getSessionId: () => this.state.sessionId ?? this.options.conversationId };
	get generation() { return this.runtime?.generation; }
	get messages() { return this.state.messages; }
	subscribe(listener: (event: OmpFrame) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	get isStreaming() { return this.state.running; }
	/** Include admission and RPC work before/after the native agent lifecycle. */
	get busy() {
		return !!(this.state.running || this.pendingInputs || this.opening || this.stopping || this.refreshing || this.reopening || this.mcpAuthPending || this.runtime?.hasPendingRequests
			|| this.state.queue?.steering.length || this.state.queue?.followUp.length
			|| this.state.recovery?.compaction || this.state.recovery?.retry || this.state.recovery?.summary || this.state.recovery?.branch);
	}
	private changed() { this.options.onChange(this.state); }
	async open(): Promise<void> {
		if (this.closed) throw Error("OMP session is closed");
		this.readPersistenceRestriction();
		if (this.persistenceFailed && !this.reopening && !this.runtime) throw Error(PERSISTENCE_FAILED);
		if (this.stopping) await this.stopping;
		if (this.closed) throw Error("OMP session is closed");
		if (this.opening) return this.opening;
		if (this.runtime) return;
		return this.opening ??= this.start().finally(() => { this.opening = undefined; });
	}
	private async start() {
		const bridge = new OmpHostTools(this.options.conversationId, this.options.tools ?? []);
		const diagnosticsRunId = randomUUID();
		const diagnose = createModelDiagnostics((this.options.env ?? process.env).PI_WEB_MODEL_DIAGNOSTICS_DIR ?? "", { engine: "omp", scope: this.options.kind ?? "chat", runId: diagnosticsRunId });
		try {
			const runtime = await createOmpRuntime({ ...this.options, sessionFile: this.state.sessionFile, messageUpdates: "full",
				recoveryTokens: this.recoveryTokens, diagnosticsRunId,
				model: this.state.model ? `${this.state.model.provider}/${this.state.model.id}` : this.options.model,
				thinking: this.selectedThinking ?? this.options.thinking,
				onTransport: transport => { this.stoppedTree = undefined; this.runtime = transport; },
				onEvent: event => {
					diagnose(event.frame);
					if (!bridge.observe(event)) this.observe(event);
					if (!this.stopping && event.frame.type === "harness_persistence" && this.persistenceFailed) void this.stop().catch(() => {});
					if (!this.stopping && event.frame.type === "harness_model_loop") {
						this.repetitionInterrupted = true; this.state.interrupted = true;
						this.state.error = "OMP 检测到模型输出持续重复，正在停止本轮；不会自动续跑。";
						this.changed();
						void this.stop().catch(() => {});
					}
				},
				onExit: () => {
					this.tasks.interrupt();
					bridge.close(); this.runtime = undefined;
					this.activityRevision++; this.recoveryRevision++;
					this.state.recovery = { lastCompaction: this.state.recovery?.lastCompaction };
					this.queueRevision++; this.state.queue = { steering: [], followUp: [] };
					this.state.running = false; this.state.streaming = undefined;
					this.state.interrupted = true; this.state.error = this.persistenceFailed ? PERSISTENCE_FAILED : this.repetitionInterrupted ? REPETITION_INTERRUPTED : "OMP process stopped; the task was not resumed.";
					for (const listener of this.listeners) listener({ type: "session_shutdown" });
					this.changed();
				},
			});
			this.runtime = runtime; this.hostTools = bridge;
			if (this.runOverrides.autoCompaction !== undefined) await runtime.request("set_auto_compaction", { enabled: this.runOverrides.autoCompaction });
			if (this.runOverrides.autoRetry !== undefined) await runtime.request("set_auto_retry", { enabled: this.runOverrides.autoRetry });
			await bridge.bind(runtime);
			await this.refresh();
		} catch (error) { bridge.close(); await this.runtime?.close(); this.runtime = undefined; throw error; }
	}
	private observe(event: OmpEnvelope) {
		if (this.runtime && event.generation !== this.runtime.generation) return;
		const frame = event.frame;
		if (frame.type === "command_output" && typeof frame.text === "string") {
			this.state.commandOutputs = appendCommandOutput(this.state.commandOutputs ?? [], { id: `${event.generation}:${event.sequence}`, timestamp: Date.now(), text: frame.text });
		}
		if (frame.type === "available_commands_update" && Array.isArray(frame.commands)) {
			this.commandRevision++;
			this.metadata.set("get_available_commands", { type: "response", data: { commands: frame.commands } });
		}
		if (isRecord(frame.message) && frame.message.role === "assistant" && typeof frame.message.timestamp === "number") {
			const timestamp = frame.message.timestamp;
			if (frame.type === "message_update" && isRecord(frame.assistantMessageEvent) && typeof frame.assistantMessageEvent.type === "string") {
				const update = frame.assistantMessageEvent;
				this.timings.observe(timestamp, { type: String(update.type), ...(typeof update.contentIndex === "number" ? { contentIndex: update.contentIndex } : {}) });
			}
			if (frame.type === "message_end") {
				this.timings.finish(timestamp);
				thinkingDurationsFor(join(this.options.dataDir, "omp/thinking-durations.json")).save(this.state.sessionFile, timestamp, this.timings.finishedDurations(timestamp));
			}
		}
		if (frame.type === "harness_persistence") {
			this.persistenceRevision++;
			this.receivePersistence(frame.persistence);
			if (!this.persistenceFailed && this.state.persistence?.relocation) this.state.sessionFile = this.state.persistence.relocation.toFile;
			if (!this.persistenceFailed) void this.refresh().catch(() => {});
		}
		this.tasks.observe(frame, event.generation);
		if (frame.type === "harness_recovery" && isRecord(frame.recovery)) {
			this.recoveryRevision++; this.activityRevision++; this.receiveRecovery(frame.recovery);
			if (this.state.recovery?.compaction || this.state.recovery?.retry) this.state.running = true;
			else void this.refresh().catch(() => {});
		}
		if (frame.type === "queue_update") { this.queueRevision++; this.updateQueue(frame); }
		if (frame.type === "agent_start") { this.activityRevision++; this.state.running = true; this.state.error = undefined; }
		if (frame.type === "message_start" || frame.type === "message_update") {
			if (isRecord(frame.message) && frame.message.role === "assistant") this.state.streaming = this.projectMessage(frame.message, this.state.messages.length);
		}
		if (frame.type === "message_end") {
			if (isRecord(frame.message) && frame.message.stopReason === "aborted") this.state.interrupted = true;
			this.revision++;
			this.state.historyBytes += Buffer.byteLength(JSON.stringify(frame.message ?? null));
			const message = this.projectMessage(frame.message, this.state.messages.length);
			if (message) this.state.messages.push(message);
			this.state.streaming = undefined;
			if (message?.stopReason === "error") this.state.error = message.errorMessage ?? "Model request failed";
			if (message?.stopReason === "length") this.state.error = "Model output limit reached; the task may be incomplete.";
		}
		if (frame.type === "extension_error") this.state.error = "OMP 扩展执行失败，请检查扩展后重试；不会自动重发。";
		if (frame.type === "prompt_result" && frame.status === "error") this.state.error = "Model request failed";
		if (frame.type === "session_settled" || (frame.type === "prompt_result" && frame.sessionSettled === true)) {
			this.activityRevision++;
			this.state.running = false; this.state.streaming = undefined;
			void this.refresh().catch(() => {});
		}
		if (this.repetitionInterrupted) { this.state.interrupted = true; this.state.error = REPETITION_INTERRUPTED; }
		if (this.persistenceFailed) { this.state.interrupted = true; this.state.error = PERSISTENCE_FAILED; }
		this.changed();
		this.options.onEvent?.(event);
		for (const listener of this.listeners) listener(frame);
	}
	private metadataTail: Promise<unknown> = Promise.resolve();
	private serializeMetadata<T>(action: () => Promise<T>): Promise<T> {
		const pending = this.metadataTail.then(action);
		this.metadataTail = pending.catch(() => {});
		return pending;
	}
	async refresh(): Promise<void> {
		if (this.stopping) return;
		const runtime = this.runtime;
		return this.refreshing ??= this.serializeMetadata(() => this.readState()).catch(error => {
			// A late passive read belongs to the closing generation. It must not
			// fail the first explicit continuation or flood the UI during Stop.
			if (this.runtime === runtime && !this.stopping) throw error;
		}).finally(() => { this.refreshing = undefined; });
	}
	private async readState() {
		const runtime = this.runtime;
		if (!runtime || this.stopping) return;
		if (!this.state.running && !this.persistenceFailed) {
			await runtime.request("harness_sync_skills");
			await runtime.request("harness_sync_models");
		}
		if (this.runtime !== runtime || this.stopping) return;
		const revision = this.revision;
		const queueRevision = this.queueRevision;
		const recoveryRevision = this.recoveryRevision, activityRevision = this.activityRevision;
		const persistenceRevision = this.persistenceRevision;
		const [state, history, catalog, tasks] = await Promise.all([runtime.request("get_state"), runtime.request("harness_history"), runtime.request("get_available_models"), runtime.request("get_subagents")]);
		if (this.runtime !== runtime || this.stopping) return;
		if (isRecord(tasks.data) && Array.isArray(tasks.data.subagents)) for (const task of tasks.data.subagents) if (isRecord(task)) this.tasks.observe({ type: "subagent_progress", payload: { ...task, progress: task.progress ?? task } }, runtime.generation);
		if (!isRecord(state.data) || !isRecord(history.data) || !Array.isArray(history.data.messages) || !isRecord(catalog.data) || !Array.isArray(catalog.data.models)) throw Error("Invalid OMP session state");
		this.mcpAuthPending = history.data.mcpAuthPending === true;
		if (persistenceRevision === this.persistenceRevision) this.receivePersistence(history.data.persistence);
		if (recoveryRevision === this.recoveryRevision && isRecord(history.data.recovery)) this.receiveRecovery(history.data.recovery);
		if (isRecord(history.data.runSettings) && typeof history.data.runSettings.autoCompaction === "boolean" && typeof history.data.runSettings.autoRetry === "boolean") this.state.runSettings = { autoCompaction: history.data.runSettings.autoCompaction, autoRetry: history.data.runSettings.autoRetry };
		if (activityRevision === this.activityRevision && typeof state.data.isSettled === "boolean") this.state.running = !state.data.isSettled || !!this.state.recovery?.compaction || !!this.state.recovery?.retry;
		if (this.options.restricted) {
			const allowed = new Set([...this.options.restricted.toolNames, ...(this.options.tools ?? []).map(tool => tool.name)]);
			if (!Array.isArray(state.data.dumpTools) || state.data.dumpTools.some(tool => !isRecord(tool) || typeof tool.name !== "string" || !allowed.has(tool.name))) throw Error("OMP business-session tool isolation failed");
		}
		this.state.models = catalog.data.models.flatMap(m => { const model = projectModel(m); return model ? [model] : []; });
		const model = projectModel(state.data.model);
		this.state.model = model && this.state.models.some(m => m.provider === model.provider && m.id === model.id) ? model : undefined;
		this.state.thinking = typeof state.data.thinkingLevel === "string" ? state.data.thinkingLevel : "off";
		if (persistenceRevision === this.persistenceRevision) {
			if (typeof state.data.sessionFile === "string") this.state.sessionFile = state.data.sessionFile;
			if (typeof state.data.sessionId === "string") {
				if (this.state.sessionId && this.state.sessionId !== state.data.sessionId) { this.state.commandOutputs = []; this.state.tree = undefined; }
				this.state.sessionId = state.data.sessionId;
			}
		}
		if (typeof state.data.sessionName === "string") this.state.sessionName = state.data.sessionName;
		this.state.tools = Array.isArray(state.data.dumpTools) ? state.data.dumpTools.flatMap(tool => isRecord(tool) && typeof tool.name === "string" ? [tool.name] : []) : [];
		const queue = state.data.queuedMessages;
		if (queueRevision === this.queueRevision && isRecord(queue)) this.updateQueue(queue);
		// Never replace newer stream messages with a concurrently requested history snapshot.
		if (revision === this.revision) this.applyHistory(history.data, runtime.generation);
		const stats = history.data.stats;
		if (isRecord(stats) && isRecord(stats.tokens)) {
			const number = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : 0;
			const usage = isRecord(stats.contextUsage) ? stats.contextUsage : {};
			this.state.stats = { totalMessages: number(stats.totalMessages), cost: number(stats.cost), tokens: { input: number(stats.tokens.input), output: number(stats.tokens.output), cacheRead: number(stats.tokens.cacheRead), cacheWrite: number(stats.tokens.cacheWrite), total: number(stats.tokens.total) }, contextUsage: { tokens: typeof usage.tokens === "number" ? usage.tokens : null, contextWindow: number(usage.contextWindow) || model?.contextWindow || 0, percent: typeof usage.percent === "number" ? usage.percent : null } };
		}
		this.state.thinkingLevels = Array.isArray(history.data.thinkingLevels) ? history.data.thinkingLevels.filter((value): value is string => typeof value === "string") : [];
		this.changed();
	}
	private applyHistory(data: Record<string, unknown>, generation: string) {
		if (!Array.isArray(data.messages)) throw Error("Invalid OMP history");
		if (isRecord(data.tree) && typeof data.tree.revision === "string") this.state.tree = data.tree as OmpSessionState["tree"];
		this.state.cwdEvents = Array.isArray(data.cwdEvents) ? data.cwdEvents.flatMap(event => isRecord(event) && typeof event.cwd === "string" && typeof event.timestamp === "number" && Number.isFinite(event.timestamp) ? [{ cwd: event.cwd, timestamp: event.timestamp }] : []) : [];
		if (Array.isArray(data.tasks)) this.tasks.restore(data.tasks, generation);
		this.state.messages = data.messages.flatMap((m, i) => {
			const entryId = isRecord(data) && Array.isArray(data.entryIds) && typeof data.entryIds[i] === "string" ? data.entryIds[i] : undefined;
			const message = this.projectMessage(m, i, entryId);
			const metadata = isRecord(data) && Array.isArray(data.messageTree) ? data.messageTree[i] : undefined;
			if (message && isRecord(metadata)) {
				if (typeof metadata.label === "string") message.label = metadata.label;
				if (isRecord(metadata.siblings)) message.siblings = metadata.siblings as unknown as NonNullable<UiMessage["siblings"]>;
			}
			// Native metadata RPCs deserialize new objects even when history has
			// not changed. Preserve immutable UI identities for snapshot deltas.
			const previous = this.state.messages[i];
			return message ? [previous && isDeepStrictEqual(previous, message) ? previous : message] : [];
		});
		this.state.historyBytes = Buffer.byteLength(JSON.stringify(data.messages));
	}
	async prompt(message: string, images?: { type: "image"; data: string; mimeType: string }[], onPromptResult?: (frame: OmpFrame) => void): Promise<boolean> {
		this.assertWritable();
		const epoch = this.inputEpoch;
		await this.open();
		if (epoch !== this.inputEpoch) throw Error("Input cancelled by Stop");
		if (this.state.running) throw Error("OMP session is already running");
		await this.refresh();
		this.assertWritable();
		if (epoch !== this.inputEpoch) throw Error("Input cancelled by Stop");
		if (this.mcpAuthPending) throw Error("请先完成或取消 MCP OAuth 授权");
		// RPC dispatch runs input hooks and local commands before deciding whether
		// a model is needed. Let the native dispatcher enforce that requirement.
		this.repetitionInterrupted = false;
		this.activityRevision++; this.state.running = true; this.state.error = undefined; this.state.interrupted = false; this.changed();
		try {
			const response = await this.runtime!.request("prompt", { message, images }, onPromptResult);
			if (isRecord(response.data) && response.data.agentInvoked === false) {
				this.state.running = false; await this.refresh();
				return true;
			}
			return false;
		}
		catch (error) {
			// A lost acknowledgement is not proof of rejection. Stop the generation,
			// retain the receipt as unknown, and never automatically send again.
			await this.stop(); throw error;
		}
	}
	private async changeModelSettings(change: (runtime: OmpTransport) => Promise<OmpFrame>) {
		this.assertWritable();
		const epoch = this.inputEpoch;
		await this.open();
		const runtime = this.runtime;
		if (epoch !== this.inputEpoch || !runtime) throw Error("Model settings change cancelled by Stop");
		// Passive metadata reads synchronize native config. Wait for their
		// mutations before submitting a model/thinking command to the RPC gate.
		await this.refresh();
		await this.serializeMetadata(async () => {
			this.assertWritable();
			if (epoch !== this.inputEpoch || this.runtime !== runtime || this.stopping) throw Error("Model settings change cancelled by Stop");
			if (this.state.running) throw Error("Stop the current task first");
			await change(runtime);
		});
		await this.refresh();
	}
	async setModel(provider: string, modelId: string) {
		await this.changeModelSettings(runtime => {
			if (!this.state.models.some(m => m.provider === provider && m.id === modelId)) throw Error("Model unavailable");
			return runtime.request("set_model", { provider, modelId });
		});
	}
	/** Product /new maps to RPC, because OMP's textual /new handler is TUI-only. */
	newSession(): Promise<boolean> {
		return this.orderedInput(async () => {
			this.assertWritable();
			const epoch = this.inputEpoch;
			await this.open();
			if (epoch !== this.inputEpoch) throw Error("Input cancelled by Stop");
			if (this.mcpAuthPending) throw Error("请先完成或取消 MCP OAuth 授权");
			const runtime = this.runtime!;
			let response: OmpFrame;
			try {
				// Passive refreshes synchronize native config and occupy the worker's
				// mutation gate. Serialize the transition behind those reads so /new
				// cannot be rejected by our own background metadata synchronization.
				response = await this.serializeMetadata(() => {
					this.assertWritable();
					if (this.runtime !== runtime || epoch !== this.inputEpoch || this.stopping) throw Error("Input cancelled by Stop");
					return runtime.request("new_session");
				});
			}
			catch (error) {
				// A lost transition reply must not leave a hook running which could
				// change the session later, after the UI has reported an unknown result.
				if (this.runtime === runtime) await this.stop().catch(() => {});
				throw error;
			}
			if (this.runtime !== runtime || epoch !== this.inputEpoch) throw Error("Input cancelled by Stop");
			if (!isRecord(response.data) || typeof response.data.cancelled !== "boolean") throw Error("Invalid native session transition response");
			if (response.data.cancelled) return false;
			// Drain any passive read started by the outgoing session's settlement,
			// then read the new identity and transcript together from the native worker.
			await this.refreshing;
			if (this.runtime !== runtime || epoch !== this.inputEpoch) throw Error("Input cancelled by Stop");
			this.tasks = new OmpTasks(); this.timings = new ThinkingTimings(); this.metadata.clear();
			this.repetitionInterrupted = false;
			this.state.streaming = undefined; this.state.error = undefined; this.state.interrupted = false;
			this.state.sessionName = undefined;
			await this.refresh();
			return true;
		});
	}
	async treeData(filter: string, query: string, previewTarget?: string): Promise<OmpFrame> {
		await this.opening;
		await this.stopping;
		if (this.closed) throw Error("Conversation closed");
		const live = await this.requestIfOpen("harness_tree", { filter, query, previewTarget });
		if (live) return live;
		await this.stopping;
		if (this.runtime || this.opening || this.closed) throw Error("Conversation changed while reading tree");
		const file = this.state.sessionFile, epoch = this.inputEpoch, snapshot = this.stoppedTree;
		if (!file && !snapshot) {
			if (this.state.messages.length || this.state.tree?.rootCount) throw Error("OMP 未保存的会话树不可读取；当前消息仍保留在界面中");
			return { type: "harness_tree", data: { entries: [], items: [], order: [], leafId: null, revision: this.state.tree?.revision ?? "empty", truncated: false } };
		}
		const result = await readOmpTree({ ...this.options, sessionFile: file }, { filter, query, previewTarget, leafId: this.stoppedLeaf, sessionId: this.state.sessionId }, snapshot);
		if (this.closed || this.runtime || this.opening || this.inputEpoch !== epoch || this.state.sessionFile !== file) throw Error("Conversation changed while reading tree");
		return result;
	}
	/** Host-only native RPC; browser requests must be validated by the product dispatcher. */
	async readMetadata(command: "get_state" | "harness_resources" | "get_available_commands" | "harness_list_sessions"): Promise<OmpFrame | undefined> {
		const revision = this.commandRevision;
		const response = await this.requestIfOpen(command);
		if (command === "get_available_commands" && revision !== this.commandRevision) return this.metadata.get(command);
		if (response) this.metadata.set(command, response);
		return response ?? this.metadata.get(command);
	}
	async requestIfOpen(command: string, payload: Record<string, unknown> = {}, onPromptResult?: (frame: OmpFrame) => void): Promise<OmpFrame | undefined> {
		const runtime = this.runtime;
		if (!runtime || this.stopping) return;
		try {
			const result = await runtime.request(command, payload, onPromptResult);
			if (this.runtime === runtime && !this.stopping) return result;
		} catch (error) { if (this.runtime === runtime && !this.stopping) throw error; }
	}
	async command(command: string, payload: Record<string, unknown> = {}, options: { open?: boolean; onPromptResult?: (frame: OmpFrame) => void } = {}): Promise<OmpFrame> {
		if (writesSession(command)) this.assertWritable();
		if (options.open !== false) await this.open();
		if (writesSession(command)) this.assertWritable();
		const result = await this.requestIfOpen(command, payload, options.onPromptResult);
		if (!result) throw Error("OMP worker stopped; reopen explicitly to continue");
		if (command === "harness_mcp" && isRecord(result.data) && typeof result.data.mcpError === "string") throw Error(result.data.mcpError);
		if (command === "harness_extensions" && isRecord(result.data) && typeof result.data.extensionError === "string") throw Error(result.data.extensionError);
		if (command === "harness_prompt" && isRecord(result.data) && typeof result.data.promptError === "string") throw Error(result.data.promptError);
		if (command === "harness_save_skills" && isRecord(result.data) && typeof result.data.skillSettingsError === "string") throw Error(result.data.skillSettingsError);
		if (command === "harness_extensions" && ["save", "toggle"].includes(String(payload.action)) || ["harness_save_skills", "harness_save_provider", "harness_refresh_provider", "harness_delete_provider", "harness_set_key", "harness_clear_key", "harness_logout"].includes(command)) {
			await Promise.allSettled([...OmpSession.live].filter(session => session.options.dataDir === this.options.dataDir && session.runtime && !session.state.running).map(session => session.refresh()));
		}
		return result;
	}
	reply(frame: OmpFrame): void {
		if (!this.runtime) throw Error("OMP session is not open");
		this.runtime.send(frame);
	}
	async setThinking(level: string) {
		if (!["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"].includes(level)) throw Error("Invalid thinking level");
		await this.changeModelSettings(runtime => runtime.request("set_thinking_level", { level }));
		this.selectedThinking = level as OmpRuntimeOptions["thinking"];
	}
	async stop(): Promise<void> { this.inputEpoch++; return this.stopping ??= this.stopOnce().finally(() => { this.stopping = undefined; }); }
	/** Only this explicit action clears a durability failure; passive reads never reopen. */
	async reopen(assertCurrent: () => void = () => {}) {
		if (this.reopening) throw Error("History reopen already in progress");
		const failed = this.persistenceFailed;
		const previousPersistence = this.state.persistence;
		const file = this.state.sessionFile;
		this.reopening = true;
		try {
			assertCurrent(); await this.stop(); assertCurrent();
			this.recoveryTokens = file ? this.journal.read(file).tokens : [];
			this.persistenceFailed = false;
			await this.open();
			assertCurrent();
			if (this.persistenceFailed) throw Error(PERSISTENCE_FAILED);
			if (file) this.journal.clear(file, this.recoveryTokens);
			this.state.persistence = { ...this.state.persistence, failed: false, externallyModified: undefined, recoveryStateUnavailable: undefined };
			this.state.error = undefined;
		} catch (error) {
			this.persistenceFailed ||= failed;
			if (this.persistenceFailed) { this.state.persistence = { ...previousPersistence, ...this.state.persistence, failed: true }; this.state.error = PERSISTENCE_FAILED; }
			await this.stop().catch(() => {});
			throw error;
		} finally { this.recoveryTokens = undefined; this.reopening = false; this.readPersistenceRestriction(); this.changed(); }
	}
	/** Explicit resource reload needs a fresh module graph, while retaining the native history. */
	async reloadResources(assertCurrent: () => void) {
		assertCurrent();
		if (this.state.running || this.state.recovery?.compaction || this.state.recovery?.retry || this.state.recovery?.summary || this.state.recovery?.branch || this.state.queue?.steering.length || this.state.queue?.followUp.length) throw Error("Stop the current task before reloading resources");
		const previous = { error: this.state.error, interrupted: this.state.interrupted };
		await this.stop(); assertCurrent();
		await this.open(); assertCurrent();
		// An intentional idle restart is not a model interruption or a failed task.
		this.state.error = previous.error; this.state.interrupted = previous.interrupted; this.changed();
	}
	private async stopOnce() {
		await this.opening;
		const runtime = this.runtime;
		if (!runtime) return;
		const wasRunning = this.state.running;
		this.stoppedTree = undefined; this.stoppedLeaf = undefined;
		try { await stopOmpRuntime(runtime, this.hostTools, async () => {
				if (this.closed) return;
				const history = await runtime.request("harness_history");
				if (this.runtime === runtime && isRecord(history.data)) { this.applyHistory(history.data, runtime.generation); this.stoppedLeaf = this.state.tree?.leafId; }
				const response = await runtime.request("harness_tree_snapshot");
				if (this.runtime !== runtime || !isRecord(response.data) || !Array.isArray(response.data.entries)) return;
				// Count the retained native tree in the existing session eviction budget.
				const bytes = Buffer.byteLength(JSON.stringify(response.data));
				if (bytes <= 16 * 1024 * 1024) { this.stoppedTree = response.data; this.state.historyBytes += bytes; }
			}); }
		finally {
			this.tasks.interrupt();
			this.runtime = undefined; this.hostTools = undefined;
			this.activityRevision++; this.recoveryRevision++;
			this.state.recovery = { lastCompaction: this.state.recovery?.lastCompaction };
			this.queueRevision++; this.state.queue = { steering: [], followUp: [] };
			this.state.running = false; this.state.streaming = undefined;
			this.state.interrupted ||= wasRunning;
			if (this.repetitionInterrupted) { this.state.interrupted = true; this.state.error = REPETITION_INTERRUPTED; }
			if (this.persistenceFailed) { this.state.interrupted = true; this.state.error = PERSISTENCE_FAILED; }
			this.changed();
		}
	}
	async close() { this.closed = true; OmpSession.live.delete(this); await this.stop(); }
}
