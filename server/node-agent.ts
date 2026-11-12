import { withOutputTokenFloor } from "./model-output-floor.js";
import { bindCacheWarming, cacheWarmingSettings, cacheWarmingView } from "./cache-warming.js";
import { modelConfigurationChanged, modelSourcesFor, type ModelSourceSync } from "./model-source-sync.js";
import { isSelectableProvider } from "./provider-catalog.js";
/** Local native Pi session whose only tools operate on one captured SSH connection. */
import { NodeCommandApprovals } from "./node-command-policy.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { createAgentSession, ModelRuntime, DefaultResourceLoader, getAgentDir, SettingsManager, SessionManager, type AgentSession, type AgentSessionEvent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { serializeMessage } from "./serialize.js";
import type { NodeAgentState, UiMessage } from "./protocol.js";

export interface NodeAgentOperations {
	command(command: string, timeout: number, signal?: AbortSignal, toolCallId?: string): Promise<{ output: string; terminalId: string; commandId: string; lines: number; durationMs: number }>;
	read(path: string, signal?: AbortSignal): Promise<string>;
	write(path: string, text: string, signal?: AbortSignal): Promise<void>;
}

export class NodeAgent {
	readonly id = randomUUID();
	private state: NodeAgentState;
	private readonly approvals = new NodeCommandApprovals(pending => this.set({ dialogs: pending.map(item => ({ id: item.id, method: "confirm", title: "请求执行 · 写入或未识别的操作", message: item.command })) }, true));
	private session?: AgentSession;
	private creating?: Promise<void>;
	private closing?: Promise<void>;
	private readonly modelRuntimes = new Set<ModelRuntime>();
	private sources?: ModelSourceSync;
	private sourceUnbind?: () => void;
	private unsubscribe?: () => void;
	private timer?: ReturnType<typeof setTimeout>;
	private generation = 0;
	private changing = false;
	private promptCancellation?: AbortController;
	private readonly lifetime = new AbortController();
	constructor(private readonly sessionDir: string, cwd: string, private readonly operations: NodeAgentOperations, private readonly changed: (state: NodeAgentState) => void, private readonly dataDir?: string) {
		this.state = { id: this.id, cwd, phase: "starting", running: false, messages: [], tools: [], models: [], dialogs: [] };
	}
	get busy(): boolean { return this.state.phase !== "closed" && (this.state.phase === "starting" || this.state.running || this.changing); }
	snapshot(): NodeAgentState { return this.state; }
	terminalCommand(command: NonNullable<NodeAgentState["terminalCommands"]>[number]) {
		this.set({ terminalCommands: [...(this.state.terminalCommands ?? []).filter(item => item.commandId !== command.commandId), command].slice(-200) }, true);
	}
	private set(patch: Partial<NodeAgentState>, immediate = false) {
		this.state = { ...this.state, ...patch };
		if (this.timer) { if (!immediate) return; clearTimeout(this.timer); this.timer = undefined; }
		if (immediate) this.changed(this.state);
		else this.timer = setTimeout(() => { this.timer = undefined; this.changed(this.state); }, 60);
	}
	private tools(): ToolDefinition[] {
		const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
		const commandParams = Type.Object({ command: Type.String({ minLength: 1, maxLength: 100000 }), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600, description: "Timeout in seconds (default 120)" })) });
		const readParams = Type.Object({ path: Type.String() });
		const writeParams = Type.Object({ path: Type.String(), text: Type.String() });
		const command: ToolDefinition<typeof commandParams> = {
			name: "remote_command", label: "SSH command",
			description: `Execute a shell command on this SSH node. Each command starts in ${JSON.stringify(this.state.cwd)}; use cd explicitly within a command to change directories. Commands run visibly in the shared interactive terminal; manual input is locked until completion. Read-only Linux queries run without confirmation. Deletions, writes, state changes and unclassified commands require confirmation for each operation. Output is limited to 64 KiB.`,
			parameters: commandParams,
			execute: async (_id, p, signal) => {
				const cancel = signalFor(signal);
				await this.approvals.request(p.command, cancel);
				const result = await this.operations.command(p.command, p.timeout ?? 120, cancel, _id);
				return { content: [{ type: "text", text: result.output }], details: { terminalId: result.terminalId, commandId: result.commandId, lines: result.lines, durationMs: result.durationMs } };
			},
		};
		const read: ToolDefinition<typeof readParams> = {
			name: "remote_read", label: "SSH read", description: "Read a UTF-8 file on this SSH node via SFTP (up to 512 KiB). Path must be absolute.", parameters: readParams,
			execute: async (_id, p, signal) => ({ content: [{ type: "text", text: await this.operations.read(p.path, signalFor(signal)) }], details: undefined }),
		};
		const write: ToolDefinition<typeof writeParams> = {
			name: "remote_write", label: "SSH write", description: "Write a UTF-8 file on this SSH node via SFTP (up to 512 KiB). Path must be absolute. Existing content is replaced.", parameters: writeParams,
			execute: async (_id, p, signal) => { await this.approvals.request(`Write ${p.path}\n${p.text}`, signalFor(signal), true); await this.operations.write(p.path, p.text, signalFor(signal)); return { content: [{ type: "text", text: "文件已写入节点" }], details: undefined }; },
		};
		return [command, read, write];
	}
	/** `fresh` starts a new conversation; a string reopens a pending new conversation's file. */
	private create(fresh: boolean | string): Promise<void> {
		const creating = this.createSession(fresh);
		this.creating = creating;
		void creating.finally(() => { if (this.creating === creating) this.creating = undefined; }).catch(() => {});
		return creating;
	}
	private async disposeSession(session: AgentSession): Promise<void> {
		try { await session.abort(); }
		finally { session.dispose(); await session.modelRuntime.settleCredentialWrites(); }
	}
	private async createSession(fresh: boolean | string) {
		const generation = ++this.generation;
		mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
		const agentDir = process.env.PI_CODING_AGENT_DIR ?? getAgentDir();
		const settings = cacheWarmingSettings(SettingsManager.create(this.sessionDir, agentDir));
		const loader = new DefaultResourceLoader({ cwd: this.sessionDir, agentDir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noContextFiles: true,
			systemPrompt: `You are the assistant for one connected SSH node. All provided tools operate only on that node. Remote working directory: ${JSON.stringify(this.state.cwd)}. Use remote_command, remote_read and remote_write for node tasks. Commands run with the SSH user's permissions. You have no local filesystem or local shell tools. Run read-only Linux queries directly using the provided tools. Every deletion, write or state-changing operation requires the tool approval dialog; never treat a previous approval as authorization for another operation. Prefer simple read-only commands over shell scripts for diagnostics. Never assume a previous command's cd persists.`, appendSystemPrompt: [] });
		await loader.reload();
		const modelRuntime = this.session?.modelRuntime ?? withOutputTokenFloor(await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") }));
		this.modelRuntimes.add(modelRuntime);
		if (this.lifetime.signal.aborted || generation !== this.generation) throw new Error("节点 Agent 已关闭");
		if (this.dataDir && !this.sources) {
			this.sources = modelSourcesFor(this.dataDir, agentDir);
			this.sourceUnbind = await this.sources.bind(modelRuntime, () => this.state.running, () => { if (this.session) this.refresh(); });
		}
		if (this.lifetime.signal.aborted || generation !== this.generation) { this.sourceUnbind?.(); throw new Error("节点 Agent 已关闭"); }
		const { session } = await createAgentSession({ cwd: this.sessionDir, agentDir, modelRuntime, resourceLoader: loader, settingsManager: settings,
			sessionManager: typeof fresh === "string" ? SessionManager.open(fresh, this.sessionDir, this.sessionDir) : fresh ? SessionManager.create(this.sessionDir, this.sessionDir) : SessionManager.continueRecent(this.sessionDir, this.sessionDir),
			model: this.session?.model, noTools: "all", tools: ["remote_command", "remote_read", "remote_write"], excludeTools: ["mcp__*"], customTools: this.tools() });
		if (this.lifetime.signal.aborted || generation !== this.generation) { await this.disposeSession(session); throw new Error("节点 Agent 已关闭"); }
		try {
			await bindCacheWarming(session, agentDir, () => this.refresh());
			this.unsubscribe?.();
			if (this.session) await this.disposeSession(this.session);
		} catch (error) { await this.disposeSession(session); throw error; }
		if (this.lifetime.signal.aborted || generation !== this.generation) { await this.disposeSession(session); throw new Error("节点 Agent 已关闭"); }
		this.session = session;
		// The SDK writes a new session file only after the first reply, so remember
		// an explicit "new conversation" until then; otherwise a reconnect would
		// continueRecent() straight back into the previous history.
		const file = session.sessionManager.getSessionFile();
		if (fresh && file) writeFileSync(this.freshMarker, JSON.stringify({ file }), { mode: 0o600 });
		else rmSync(this.freshMarker, { force: true });
		this.unsubscribe = session.subscribe(event => { if (this.session === session && this.state.phase !== "closed") this.event(event); });
		this.refresh();
		this.set({ phase: "ready", running: false, error: undefined, tools: [], streamingMessage: undefined }, true);
	}
	private get freshMarker() { return join(this.sessionDir, "fresh-session.json"); }
	/** The last explicit new conversation's file while it has not been written yet. */
	private pendingFresh(): string | false {
		try {
			const { file } = JSON.parse(readFileSync(this.freshMarker, "utf8")) as { file?: unknown };
			return typeof file === "string" && file.startsWith(this.sessionDir) && !existsSync(file) ? file : false;
		} catch { return false; }
	}
	async start() {
		try { await this.create(this.pendingFresh()); }
		catch (error) { if (this.state.phase !== "closed") { this.set({ error: (error as Error).message }); await this.close(); } throw error; }
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.sourceUnbind?.();
		this.generation++; this.lifetime.abort(); this.approvals.reset();
		this.unsubscribe?.(); this.unsubscribe = undefined;
		const session = this.session; this.session = undefined;
		this.set({ phase: "closed", running: false, streamingMessage: undefined, dialogs: [], tools: this.state.tools.map(tool => ({ ...tool, running: false })) }, true);
		this.closing = (async () => {
			await Promise.allSettled([this.creating, session ? this.disposeSession(session) : undefined]);
			this.sourceUnbind?.();
			await Promise.all([...this.modelRuntimes].map(runtime => runtime.settleCredentialWrites()));
		})();
		return this.closing;
	}
	private ready(): AgentSession {
		if (this.state.phase !== "ready" || !this.session || this.changing) throw new Error("节点 Agent 尚未就绪");
		return this.session;
	}
	private retain(messages: UiMessage[]): UiMessage[] {
		let bytes = 0, start = messages.length;
		while (start > 0 && messages.length - start < 200) {
			const size = Buffer.byteLength(JSON.stringify(messages[start - 1]));
			if (start < messages.length && bytes + size > 4 * 1024 * 1024) break;
			bytes += size; start--;
		}
		return messages.slice(start);
	}
	refresh() {
		const session = this.session;
		if (!session) return;
		const stats = session.getSessionStats();
		this.set({ stats: { totalMessages: stats.totalMessages, tokens: stats.tokens, cost: stats.cost, contextUsage: stats.contextUsage ?? { tokens: null, contextWindow: 0, percent: null }, cacheWarming: cacheWarmingView(session) },
			messages: this.retain(session.messages.slice(-200).map((message, index) => serializeMessage(message, Math.max(0, session.messages.length - 200) + index)).filter((message): message is UiMessage => !!message)),
			model: session.model ? { id: session.model.id, provider: session.model.provider, name: session.model.name } : undefined,
			models: session.modelRuntime.getAvailableSnapshot().filter(model => this.sources?.visible(model.provider) ?? isSelectableProvider(model.provider)).map(model => ({ id: model.id, provider: model.provider, name: model.name })) });
	}
	async prompt(text: string, queue?: "steer" | "followUp") {
		const session = this.ready();
		const release = await this.sources?.acquire(session.modelRuntime);
		try {
			if (session.model && this.sources && !this.sources.accepts(session.modelRuntime, session.model.provider, session.model.id)) throw new Error("当前模型来源不可用，请选择其他模型");
			if (!session.isStreaming && session.model) { const updated = session.modelRuntime.getModel(session.model.provider, session.model.id); if (!updated && this.sources?.owns(session.model.provider)) throw new Error("当前模型已移除"); if (updated && modelConfigurationChanged(updated, session.model)) await session.setModel(updated); }
			if (!text.trim() || text.length > 200000) throw new Error("消息无效");
			if (!session.model) throw new Error("请先在本机设置中配置模型，再重新打开节点 Agent");
			if (this.state.running) {
				if (!queue || !session.isStreaming) throw new Error("节点 Agent 正在处理请求，请稍后或排队发送");
				await session.prompt(text, { streamingBehavior: queue, expandPromptTemplates: false }); return;
			}
			this.set({ running: true, error: undefined, tools: [] }, true);
			const cancellation = new AbortController();
			this.promptCancellation = cancellation;
			const signal = AbortSignal.any([cancellation.signal, this.lifetime.signal]);
			await new Promise<void>((resolve, reject) => {
				void session.prompt(text, { expandPromptTemplates: false, preflightResult: disposition => {
					// Abort during asynchronous auth/compaction must prevent a later model call.
					// SDK 1.2 marks the run active before "started" and does not guard this
					// callback, so throwing here would strand the session busy. Abort the
					// starting run instead: the SDK stops it at agent_start, before any request.
					if (signal.aborted) {
						const stopped = () => reject(new Error("已停止"));
						// Report the stop only once the aborted run has settled, so the next prompt is accepted.
						if (disposition === "started") void session.abort().catch(() => {}).finally(stopped);
						else { if (!session.isStreaming) this.set({ running: false }); stopped(); }
						return;
					}
					if (disposition !== "started" && !session.isStreaming) this.set({ running: false });
					resolve();
				} }).catch(error => {
					reject(error);
					if (this.session === session && this.state.phase !== "closed" && this.promptCancellation === cancellation) {
						this.refresh(); this.set({ running: false, error: signal.aborted ? undefined : (error as Error).message }, true);
					}
				});
			});
		} finally { release?.(); }
	}
	async abort() {
		const session = this.ready();
		this.promptCancellation?.abort();
		await session.abort();
		if (this.session === session && this.state.phase === "ready") this.set({ running: false }, true);
	}
	async newSession() {
		this.ready(); if (this.busy) throw new Error("请先停止当前任务");
		this.changing = true;
		try { this.approvals.reset(); this.set({ terminalCommands: [] }); await this.create(true); } finally { this.changing = false; }
	}
	async model(provider: string, modelId: string) {
		const session = this.ready(); if (this.busy) throw new Error("请先停止当前任务");
		await this.sources?.ready(session.modelRuntime);
		if (this.sources && !this.sources.accepts(session.modelRuntime, provider, modelId)) throw new Error("模型来源不可用");
		const model = session.modelRuntime.getAvailableSnapshot().find(model => model.provider === provider && model.id === modelId);
		if (!model) throw new Error("本机模型不可用");
		this.changing = true;
		try { await session.setModel(model, { persist: false }); if (this.session === session) this.refresh(); } finally { this.changing = false; }
	}
	dialog(id: string, response: { cancelled?: boolean; value?: string; confirmed?: boolean; remember?: boolean }) { this.approvals.respond(id, response.confirmed === true && !response.cancelled, response.remember); }
	private event(event: AgentSessionEvent) {
		if (event.type === "entry_appended" && event.entry.type === "usage") this.refresh();
		if (["agent_start", "compaction_start", "auto_retry_start"].includes(event.type)) this.set({ running: true });
		if (event.type === "message_start" && event.message.role === "assistant") this.set({ streamingMessage: serializeMessage(event.message, this.session!.messages.length) ?? undefined });
		if (event.type === "message_update") this.set({ streamingMessage: serializeMessage(event.message, this.session!.messages.length) ?? undefined });
		if (event.type === "message_end") { this.refresh(); if (event.message.role === "assistant") this.set({ streamingMessage: undefined }); }
		if (event.type === "tool_execution_start" || event.type === "tool_execution_end") this.set({ tools: [...this.state.tools.filter(tool => tool.id !== event.toolCallId), { id: event.toolCallId, name: event.toolName, running: event.type === "tool_execution_start", isError: event.type === "tool_execution_end" && event.isError }].slice(-256) });
		if (event.type === "agent_settled") { this.refresh(); this.set({ running: false, streamingMessage: undefined }, true); void this.sources?.ready(this.session!.modelRuntime).then(() => this.refresh()).catch(() => {}); }
	}
}
