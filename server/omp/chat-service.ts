import { OmpExtensionUi } from "./extension-ui.js";
import { OmpProviderAuth } from "./provider-auth.js";
import { OmpQueueRecalls } from "./queue-recall.js";
import { projectCommands } from "./commands.js";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { existsSync, realpathSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { readTree } from "./tree.js";
import { OmpNavigation, OmpNavigationBusyError } from "./navigation.js";
import { projectMessage } from "./presentation.js";
import { appVersion } from "../app-version.js";
import { OmpWikiConversations } from "./wiki-conversations.js";
import type { PluginToolEvent } from "../plugins.js";
import { databaseScope, forgetDatabaseScope } from "../database/service.js";
import { databaseTool } from "./database-tool.js";
import { deleteOmpHistory, latestOmpHistory, listOmpProjects, readOmpToolOutput } from "./runtime.js";
import { openOmpArtifact, outputDenied } from "./tool-output.js";
import { OmpSession } from "./session.js";
import { OmpPersistenceJournal } from "./persistence-journal.js";
import { isRecord } from "./framing.js";
import type { OmpEnvelope, OmpFrame } from "./transport.js";
import { ClientStateStore, mergeProjectSummaries } from "../client-state.js";
import { FilesService, existingConversationFiles } from "../files-service.js";
import { CodeSearch } from "../code-search.js";
import { TerminalManager, loadCommands, saveCommandsFile } from "../terminals.js";
import { browseDirs } from "../dir-browser.js";
import { promptReceiptsFor } from "../prompt-receipts.js";
import { writeFileAtomic } from "../private-file.js";
import type { ClientMessage, ServerMessage, UiState, UiMessage, TreeRequest, PromptAttachment, PromptResult, UiModelInfo, SessionSummary, UiProviderConfig, ProviderStatus, UiSettingsState } from "../protocol.js";
import { OMP_VERSION } from "./bootstrap.js";
import { OmpPackages } from "./packages.js";
import { buildAttachmentMessages } from "../attachments.js";
import { composeOmpPrompt, resolveOmpAttachments } from "./attachments.js";
import { nativeEntryMessage } from "./native-messages.js";

export { workspacePath } from "../files-service.js";
export class QuiesceRejectedError extends Error {}
class SessionInUseError extends Error {}
type Sink = (message: ServerMessage) => void;
type Chat = { id: string; cwd: string; wiki: boolean; createdAt: number; session: OmpSession; terminals: TerminalManager };
type SavedChat = { cwd: string; wiki: boolean; sessionFile?: string; model?: string; thinking?: string };
type PreparedPrompt = { message: string; images: { type: "image"; data: string; mimeType: string }[] };

type BranchSummaryOperation = { id: string; requestId: string; chat: Chat; generation: string | undefined; done: boolean; cancelling: boolean; cancellation?: Promise<void>; wake?: () => void };

function canonicalPath(file: string) { try { return realpathSync(file); } catch { return resolve(file); } }

function systemPromptText(data: unknown): string {
	if (!isRecord(data) || !Array.isArray(data.systemPrompt) || !data.systemPrompt.every(part => typeof part === "string")) return "";
	return data.systemPrompt.join("\n\n");
}

/** Owns product navigation and transport; all agent execution belongs to OMP. */
export class OmpClientSession {
	private branchSummary?: BranchSummaryOperation;
	private navigation = new OmpNavigation(() => this.flushSnapshot());
	private recalls = new OmpQueueRecalls(result => this.emit(result));
	private sinks = new Set<Sink>();
	private chats = new Map<string, Chat>();
	private deletingChats = new Set<string>();
	private activeId = "";
	private revision = 0;
	private snapshotBase?: Pick<UiState, "conversationId" | "sessionId" | "rev" | "messages">;
	private toolMessages = new WeakMap<UiMessage, { conversationId: string; message: UiMessage }>();
	private cwdDrain?: Promise<void>;
	private queuedCwd?: { execute(): Promise<void>; supersede(): void };
	private timer?: ReturnType<typeof setTimeout>;
	private disposed = false;
	private initialized = false;
	private pendingOperations = 0;
	private passiveRequests = new AbortController();
	private projectsRead?: Promise<void>;
	lastActivityAt = Date.now();
	private statePath: string;
	private lastSaved = "";
	private extensionUi = new OmpExtensionUi(message => this.emit(message));
	private files: FilesService;
	private search: CodeSearch;
	private auth: OmpProviderAuth;
	switchingWorkspace = false;
	isQuiesced = () => false;
	onCwdChanged?: (cwd: string) => void;
	onToolEvent?: (event: PluginToolEvent) => void;
	assertSessionAvailable = (_file: string) => {};
	reserveSessionDeletion = (_file: string): (() => void) => () => {};
	constructor(readonly clientId: string, public cwd: string, private store: ClientStateStore) {
		const directory = join(store.dataDir, "omp", "clients");
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		this.statePath = join(directory, `${createHash("sha256").update(clientId).digest("hex")}.json`);
		this.files = new FilesService({ emit: message => this.emit(message), isDisposed: () => this.disposed, getCwd: () => this.cwd, getActiveCwd: () => this.cwd });
		this.search = new CodeSearch(message => this.emit(message));
		this.auth = new OmpProviderAuth(store.dataDir, message => this.emit(message));
	}
	get conversationId() { return this.activeId; }
	private get chat() { const chat = this.chats.get(this.activeId); if (!chat) throw Error("Conversation unavailable"); return chat; }
	get session() { return this.chat.session; }
	get activeIsWiki() { return this.chat.wiki; }
	get connected() { return this.sinks.size > 0; }
	get canEvict() {
		return this.initialized && !this.disposed && !this.connected && !this.pendingOperations && !this.switchingWorkspace && !this.cwdDrain && !this.navigation.busy
			&& ![...this.chats.values()].some(chat => chat.session.busy || chat.terminals.list().some(terminal => terminal.running));
	}
	/** File reads belong to the directory, not the native conversation being prepared. */
	get workspaceReady() { return this.initialized && !this.disposed && !this.cwdDrain; }
	async initialize(wiki = false) {
		this.switchingWorkspace = true;
		let saved: SavedChat | undefined;
		try { saved = JSON.parse(readFileSync(this.statePath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		const file = saved?.cwd === this.cwd && saved.wiki === wiki ? saved.sessionFile : undefined;
		const restore = file && (existsSync(file) || new OmpPersistenceJournal(join(this.store.dataDir, "omp")).read(file).tokens.length > 0);
		await this.createChat(this.cwd, wiki, restore ? file : !wiki ? await latestOmpHistory({ dataDir: this.store.dataDir, cwd: this.cwd }) : undefined);
		this.initialized = true;
		this.switchingWorkspace = false;
	}
	private persist() {
		if (!this.activeId) return;
		const chat = this.chat, state = chat.session.state;
		const serialized = JSON.stringify({ cwd: chat.cwd, wiki: chat.wiki, sessionFile: state.sessionFile,
			model: state.model ? `${state.model.provider}/${state.model.id}` : undefined, thinking: state.thinking } satisfies SavedChat);
		if (serialized !== this.lastSaved) { writeFileAtomic(this.statePath, serialized); this.lastSaved = serialized; }
	}
	private async createChat(cwd: string, wiki = false, sessionFile?: string) {
		if (this.disposed || this.isQuiesced()) throw new QuiesceRejectedError("Service draining");
		if (sessionFile) this.assertSessionAvailable(canonicalPath(sessionFile));
		if ([...this.chats.values()].filter(chat => chat.cwd === cwd).length >= 8) {
			const idle = [...this.chats.values()].find(chat => chat.cwd === cwd && chat.id !== this.activeId && !chat.session.isStreaming && !chat.terminals.list().length);
			if (!idle) throw Error("Maximum open conversations reached; stop a task first");
			await idle.session.close(); forgetDatabaseScope(databaseScope(this.clientId, idle.cwd, idle.session.sessionManager)); this.chats.delete(idle.id);
		}
		const id = randomUUID();
		const previous = this.activeId ? this.session.state : undefined;
		const session: OmpSession = new OmpSession({ conversationId: id, dataDir: this.store.dataDir, cwd, kind: wiki ? "wiki" : "chat", sessionFile, askDialog: true,
			tools: [databaseTool(cwd, () => databaseScope(this.clientId, cwd, session.sessionManager))],
			model: previous?.model ? `${previous.model.provider}/${previous.model.id}` : undefined,
			onChange: () => {
				if (!this.chats.has(id) || this.disposed) return;
				this.lastActivityAt = Date.now();
				this.extensionUi.synchronize(id, session.generation);
				if (id === this.activeId) { this.persist(); this.scheduleSnapshot(); }
				this.pushConversations();
			},
			onEvent: event => this.nativeEvent(id, event),
		});
		const terminals = new TerminalManager(message => {
			this.lastActivityAt = Date.now();
			if (message.type === "terminal_output" && id !== this.activeId) return;
			this.emit(message.type === "terminal_output" || message.type === "terminal_exit" || message.type === "terminal_list" ? { ...message, conversationId: id } : message);
		}, cwd);
		const chat: Chat = { id, cwd, wiki, createdAt: Date.now(), session, terminals };
		const oldId = this.activeId;
		this.chats.set(id, chat);
		// Keep the old conversation authoritative until the new worker is ready.
		if (!oldId) this.activeId = id;
		this.flushSnapshot();
		try { if (!session.state.persistence?.failed) await session.open(); }
		catch (error) { this.chats.delete(id); this.activeId = oldId; await session.close(); terminals.killAll(); throw error; }
		if (this.disposed) { await session.close(); terminals.killAll(); throw Error("Client closed"); }
		this.chats.set(id, chat); this.activeId = id; this.cwd = cwd;
		this.store.remember(this.clientId, cwd); this.persist(); this.flushSnapshot();
		this.publishCommandCatalog();
		return chat;
	}
	private nativeEvent(id: string, event: OmpEnvelope) {
		const frame = event.frame;
		if (frame.type === "available_commands_update" && id === this.activeId && Array.isArray(frame.commands)) this.emit({ type: "slash_commands", commands: projectCommands(frame.commands) });
		if (frame.type === "harness_model_loop") this.emit({ type: "notice", level: "warning", conversationId: id, text: "OMP 检测到模型输出持续重复，已请求停止本轮；不会自动续跑。" });
		if (frame.type === "harness_persistence" && isRecord(frame.persistence)) {
			const failed = frame.persistence.failed === true;
			this.emit({ type: "notice", level: failed ? "error" : "warning", conversationId: id, text: failed
				? frame.persistence.externallyModified === true ? "历史文件已被其他程序修改，已请求停止所属对话并阻止继续写入。请检查文件后明确重新读取历史；不会自动重发。" : "OMP 历史保存失败，已请求停止所属对话。请修复存储问题，再重新读取已保存历史；不会自动重发。"
				: "OMP 检测到历史文件写入冲突，已保留原文件并转存到新的会话文件。" });
		}
		if ((frame.type === "tool_execution_start" || frame.type === "tool_execution_end") && typeof frame.toolName === "string") this.onToolEvent?.({ phase: frame.type === "tool_execution_start" ? "start" : "end", conversationId: id, toolName: frame.toolName, isError: frame.isError === true });
		this.extensionUi.observe(event);
		if (frame.type === "extension_error") this.emit({ type: "notice", level: "error", conversationId: id, text: "OMP 扩展执行失败，请检查扩展后重试；不会自动重发。" });

		if (frame.type === "tool_execution_end" && typeof frame.toolCallId === "string") {
			this.emit({ type: "tool_status", conversationId: id, toolCallId: frame.toolCallId, toolName: typeof frame.toolName === "string" ? frame.toolName : "", isError: frame.isError === true, running: false });
		}
		if (frame.type === "session_settled") { if (id === this.activeId) this.flushSnapshot(); }
	}
	attachSink(sink: Sink, initialize = true) { this.lastActivityAt = Date.now(); this.sinks.add(sink); this.auth.replay(); this.flushSnapshot(true); this.recalls.replay(sink); for (const chat of this.chats.values()) { this.extensionUi.synchronize(chat.id, chat.session.generation); this.extensionUi.replay(chat.id, sink); } if (initialize) void this.pushInitial().catch(error => this.emitNotice("error", String(error))); }
	detachSink(sink: Sink) { this.lastActivityAt = Date.now(); this.sinks.delete(sink); }
	emit(message: ServerMessage) { if (!this.disposed) for (const sink of this.sinks) sink(message); }
	emitNotice(level: "info" | "error" | "warning", text: string) { this.emit({ type: "notice", level, text }); }
	private scheduleSnapshot() { this.timer ??= setTimeout(() => { this.timer = undefined; this.flushSnapshot(); }, 60); }
	private toolMessage(message: UiMessage, conversationId: string): UiMessage {
		if (message.role !== "toolResult" || !message.toolCallId) return message;
		const cached = this.toolMessages.get(message);
		if (cached?.conversationId === conversationId) return cached.message;
		const projected = { ...message, toolOutputUrl: `/api/tool-output?${new URLSearchParams({ clientId: this.clientId, conversationId, toolCallId: message.toolCallId })}` };
		this.toolMessages.set(message, { conversationId, message: projected });
		return projected;
	}
	flushSnapshot(force = false) {
		if (!this.activeId || this.disposed) return;
		clearTimeout(this.timer); this.timer = undefined;
		const chat = this.chat, native = chat.session.state;
		const usage = native.messages.reduce((sum, message) => { if (message.usage) for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) sum[key] += message.usage[key]; return sum; }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
		const state: UiState = {
			clientId: this.clientId, cwd: chat.cwd, sessionId: native.sessionId ?? chat.id, sessionFile: native.sessionFile, conversationId: chat.id,
			cwdEvents: (native.cwdEvents ?? []).map(event => ({ ...event, cwd: chat.cwd })), rev: ++this.revision, version: this.revision, messages: native.messages.map(message => this.toolMessage(message, chat.id)), streamingMessage: native.streaming ?? null,
			isStreaming: native.running || this.switchingWorkspace || this.navigation.busy, wiki: chat.wiki, model: native.model ? this.modelInfo(native.model) : null, thinkingLevel: native.thinking,
			availableThinkingLevels: native.thinkingLevels ?? [], queue: native.queue ?? { steering: [], followUp: [] }, errorMessage: native.error,
			ompTasks: chat.session.taskSnapshot(),
			tree: native.tree ? { ...native.tree, busy: this.navigation.busy || !!native.recovery?.compaction || !!native.recovery?.retry, verifying: false, externallyModified: native.persistence?.externallyModified === true } : undefined,
			branchSummary: this.branchSummary?.chat === chat && !this.branchSummary.done ? { operationId: this.branchSummary.id, requestId: this.branchSummary.requestId, cancelling: this.branchSummary.cancelling } : undefined,
			commandOutputs: native.commandOutputs ?? [],
			sessionPersistence: native.persistence,
			recovery: chat.session.recoverySnapshot(), runSettings: native.runSettings,
			tools: native.tools ?? [], piConfigured: native.models.length > 0, piAgentInstalled: true,
			stats: native.stats ?? { totalMessages: native.messages.length, tokens: { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite }, cost: 0,
				contextUsage: { tokens: null, contextWindow: native.model?.contextWindow ?? 0, percent: null } },
		};
		const previous = this.snapshotBase;
		if (!force && previous?.conversationId === state.conversationId && previous.sessionId === state.sessionId
			&& previous.messages.length <= state.messages.length && previous.messages.every((message, index) => message === state.messages[index])) {
			const { messages, ...light } = state;
			this.emit({ type: "snapshot_delta", conversationId: state.conversationId, rev: state.rev, baseRev: previous.rev,
				appended: messages.slice(previous.messages.length), state: light });
		} else this.emit({ type: "snapshot", state });
		// This array is a projection, never the mutable native event accumulator.
		this.snapshotBase = { conversationId: state.conversationId, sessionId: state.sessionId, rev: state.rev, messages: state.messages };
		this.pushConversations();
	}
	private modelInfo(model: { provider: string; id: string; name: string }): UiModelInfo { return { provider: model.provider, id: model.id, name: model.name, vision: "vision" in model && model.vision === true }; }
	private pushConversations() {
		this.emit({ type: "conversations", activeId: this.activeId, conversations: [...this.chats.values()].filter(chat => chat.cwd === this.cwd).map(chat => ({ id: chat.id, cwd: chat.cwd, title: chat.session.state.sessionName || this.title(chat), createdAt: chat.createdAt,
			messageCount: chat.session.state.messages.length, branchPoints: chat.session.state.tree?.branchPoints, isStreaming: chat.session.state.running || chat.id === this.activeId && this.navigation.busy, sessionFile: chat.session.state.sessionFile })) });
	}
	private title(chat: Chat) { return chat.session.state.messages.find(message => message.role === "user")?.content.filter(block => block.type === "text").map(block => String("text" in block ? block.text : "")).join(" ").slice(0, 80) || "新对话"; }
	private async pushInitial() { await this.listModels(); await this.refreshSessions(); this.pushProjects(); await this.pushSettings(); await this.pushSlashCommands(); }
	queryPromptReceipt(requestId: string) { return promptReceiptsFor(this.store.dataDir).query(this.clientId, requestId); }
	private async preparePrompt(chat: Chat, text: string, attachments: PromptAttachment[] | undefined, assertCurrent: () => void): Promise<PreparedPrompt> {
		if (typeof text !== "string" || (!text.trim() && !attachments?.length)) throw Error("Empty prompt");
		const resolved = await resolveOmpAttachments(chat.session, attachments);
		assertCurrent();
		const asides = await buildAttachmentMessages({ cwd: chat.cwd, clientId: this.clientId, emit: message => this.emit(message) }, resolved);
		assertCurrent();
		return composeOmpPrompt(text, asides);
	}
	async prompt(text: string, attachments?: PromptAttachment[], queue?: "steer" | "followUp" | boolean, requestId: string = randomUUID(), admitted?: (ok: boolean) => void, target?: { conversationId?: string; cwd?: string; sessionId?: string }, navigationLease?: symbol, prepared?: PreparedPrompt) {
		this.pendingOperations++;
		const assertNotStopped = this.navigation.checkpoint();
		const receipts = promptReceiptsFor(this.store.dataDir);
		let dispatched = false, claimed = false;
		try {
			const previous = receipts.begin(this.clientId, requestId, { text, attachments, queue, target });
			if (previous) { this.emit(previous); admitted?.(previous.ok); return; }
			claimed = true;
			this.navigation.assertAvailable(navigationLease);
			if (this.isQuiesced() || this.switchingWorkspace) throw Error("Conversation unavailable");
			const chat = this.chat;
			chat.session.assertWritable();
			if (target && ((target.conversationId && target.conversationId !== chat.id) || (target.cwd && target.cwd !== chat.cwd) || (target.sessionId && target.sessionId !== chat.session.state.sessionId))) throw Error("Conversation changed");
			const assertCurrent = () => {
				if (this.disposed || this.chat !== chat || this.switchingWorkspace) throw Error("Conversation changed");
				assertNotStopped();
				this.navigation.assertAvailable(navigationLease);
			};
			if (/^\/new(?:\s|$)/u.test(text.trim())) {
				if (text.trim() !== "/new") throw Error("/new 不接受参数；请先新建会话，再发送问题。");
				const sessionId = chat.session.state.sessionId;
				const execute = async (check: () => void) => {
					check(); dispatched = true;
					const changed = await chat.session.newSession();
					check(); this.persist(); this.flushSnapshot();
					const result: PromptResult = { type: "prompt_result", requestId, conversationId: chat.id, sessionId, ok: changed,
						commandExecuted: changed, attachmentsConsumed: false, receipt: changed ? "accepted" : "rejected" };
					this.emit(receipts.finish(this.clientId, result)); admitted?.(changed);
					if (!changed) this.emit({ type: "notice", level: "info", conversationId: chat.id, text: "OMP 已取消新建会话，当前历史保持不变。" });
					// Metadata failure after an acknowledged transition must not replace
					// its durable success receipt with an unknown result.
					try { await this.refreshSessions(); await this.pushSlashCommands(); }
					catch (error) { this.emitNotice("error", (error as Error).message); }
				};
				if (navigationLease) await execute(assertCurrent);
				else await this.navigation.run(() => !this.disposed && this.chat === chat && !this.switchingWorkspace, execute);
				return;
			}
			const input = prepared ?? await this.preparePrompt(chat, text, attachments, assertCurrent);
			assertCurrent();
			dispatched = true;
			let admittedResult: PromptResult | undefined, completed: OmpFrame | undefined;
			const complete = (frame: OmpFrame) => {
				completed = frame;
				if (!admittedResult || frame.agentInvoked !== false || frame.status !== "completed") return;
				// This augments admission metadata; it never changes accepted to rejected
				// or treats extension handler failure as proof that nothing executed.
				// Queries/reconnects can read this metadata. Do not publish a second
				// unsolicited receipt that could replace a newer composer acknowledgement.
				receipts.finish(this.clientId, { ...admittedResult, commandExecuted: true });
			};
			const local = await chat.session.submit(input.message, input.images, queue === true || queue === "followUp" ? "followUp" : "steer", complete);
			const result: PromptResult = { type: "prompt_result", requestId, conversationId: chat.id, sessionId: chat.session.state.sessionId, ok: true, receipt: "accepted",
				...(local ? { commandExecuted: true, attachmentsConsumed: false } : {}) };
			admittedResult = receipts.finish(this.clientId, result); this.emit(admittedResult); admitted?.(true);
			if (completed) complete(completed);
			void chat.session.refresh().catch(error => this.emitNotice("error", (error as Error).message));
		} catch (error) {
			this.emitNotice("error", (error as Error).message);
			if (claimed) this.emit(receipts.finish(this.clientId, { type: "prompt_result", requestId, ok: false, receipt: dispatched ? "unknown" : "rejected" }));
			admitted?.(false);
		} finally { this.pendingOperations--; this.lastActivityAt = Date.now(); }
	}
	async abort() { this.navigation.cancel(); const session = this.session; await session.stop(); this.flushSnapshot(); }
	async newChat(fresh = false, wiki = this.activeIsWiki) {
		this.navigation.assertAvailable();
		if (this.switchingWorkspace) throw Error("Workspace changing");
		if (!fresh && !wiki) {
			const blank = [this.chat, ...this.chats.values()].find(chat => chat.cwd === this.cwd && !chat.wiki && !chat.session.state.running && !chat.session.state.persistence?.failed
				&& !chat.session.state.messages.length && !chat.session.state.streaming && !chat.terminals.list().length);
			if (blank) { if (blank.id !== this.activeId) await this.switchConversation(blank.id); this.flushSnapshot(); return false; }
		}
		this.switchingWorkspace = true;
		try { await this.createChat(this.cwd, wiki); return true; }
		finally { this.switchingWorkspace = false; this.flushSnapshot(); }
	}
	async switchConversation(id: string) {
		this.navigation.assertAvailable();
		if (this.switchingWorkspace) throw Error("Workspace changing");
		const chat = this.chats.get(id); if (!chat) throw Error("Unknown conversation");
		this.activeId = id; this.cwd = chat.cwd; this.chats.delete(id); this.chats.set(id, chat); this.persist(); this.flushSnapshot(); this.pushProjects();
		for (const replay of chat.terminals.replay()) this.emit({ type: "terminal_output", conversationId: id, ...replay, reset: true });
		this.publishCommandCatalog();
	}
	setCwd(path: string, requestId?: string, source: "ui" | "command" = "ui"): Promise<void> {
		return new Promise((resolveRequest, rejectRequest) => {
			const finish = (error?: unknown) => {
				if (requestId) this.emit({ type: "cwd_result", requestId, cwd: this.cwd, ok: !error, ...(error ? { error: (error as Error).message } : {}) });
				if (error && !requestId) rejectRequest(error); else resolveRequest();
			};
			if (this.disposed || this.switchingWorkspace && !this.cwdDrain) { finish(Error("Workspace unavailable")); return; }
			this.queuedCwd?.supersede();
			this.queuedCwd = {
				supersede: () => finish(Error("superseded")),
				execute: async () => {
					try {
						this.navigation.assertAvailable();
						if (this.disposed || this.isQuiesced()) throw Error("Workspace unavailable");
						const cwd = resolve(path); if (!statSync(cwd).isDirectory()) throw Error("Invalid workspace");
						const wiki = this.activeIsWiki;
						const existing = [...this.chats.values()].reverse().find(chat => chat.cwd === cwd && chat.wiki === wiki);
						if (existing) {
							this.activeId = existing.id; this.cwd = cwd;
							this.chats.delete(existing.id); this.chats.set(existing.id, existing);
						} else await this.createChat(cwd, wiki, wiki ? undefined : await latestOmpHistory({ dataDir: this.store.dataDir, cwd }));
						if (source === "command") {
							try { await this.session.command("harness_cwd_event"); await this.session.refresh(); }
							catch { this.emitNotice("warning", "工作目录已切换，但切换记录未能保存。"); }
						}
						this.store.remember(this.clientId, cwd); this.persist(); this.flushSnapshot(); this.pushProjects(); this.onCwdChanged?.(cwd);
						this.publishCommandCatalog();
						finish();
					} catch (error) { finish(error); }
				},
			};
			this.cwdDrain ??= this.drainCwd();
		});
	}
	private async drainCwd() {
		this.switchingWorkspace = true;
		try {
			while (this.queuedCwd) {
				const request = this.queuedCwd; this.queuedCwd = undefined;
				await request.execute();
			}
		} finally { this.cwdDrain = undefined; this.switchingWorkspace = false; this.flushSnapshot(); }
	}

	getTerminalManager(id = this.activeId) {
		if (this.deletingChats.has(id)) throw new SessionInUseError("正在关闭此会话，请稍后重试");
		return this.chats.get(id)?.terminals;
	}
	getTerminalCwd(id = this.activeId) { return this.chats.get(id)?.cwd ?? this.cwd; }
	async listModels() { await this.session.refresh(); this.emit({ type: "models", models: this.session.state.models.map(model => ({ ...this.modelInfo(model), id: `${model.provider}/${model.id}`, reasoning: model.reasoning })) }); }
	async setModel(key: string) { this.navigation.assertAvailable(); const model = this.session.state.models.find(model => `${model.provider}/${model.id}` === key || model.id === key); if (!model) throw Error("OMP model unavailable"); await this.session.setModel(model.provider, model.id); this.persist(); }
	private publishCommandCatalog(session = this.session) {
		this.emit({ type: "slash_commands", commands: projectCommands(session.commandCatalog) });
	}
	async pushSlashCommands() {
		const session = this.session;
		this.publishCommandCatalog(session);
		const response = await session.readMetadata("get_available_commands");
		if (this.session !== session) return;
		const commands = isRecord(response?.data) && Array.isArray(response.data.commands) ? response.data.commands : [];
		this.emit({ type: "slash_commands", commands: projectCommands(commands) });
	}
	pushProjects(): Promise<void> {
		if (this.disposed) return Promise.resolve();
		return this.projectsRead ??= this.readProjects().finally(() => { this.projectsRead = undefined; });
	}
	private async readProjects() {
		// This passive read owns no conversation. It must not prevent a closed
		// window's history from being claimed; dispose still awaits projectsRead.
		try {
			const disk = await listOmpProjects({ dataDir: this.store.dataDir, cwd: this.cwd });
			if (this.disposed) return;
			// Read current tombstones after the asynchronous catalog so a late
			// result cannot restore a project that the user has just removed.
			const saved = this.store.get(this.clientId).projects, removed = this.store.getRemovedProjects(this.clientId);
			// OMP stores canonical cwd paths; preserve the user's saved alias and
			// removal marker (for example /var versus /private/var on macOS).
			const aliases = new Map([...removed, ...saved.toReversed().map(project => project.path)].map(path => [canonicalPath(path), path]));
			const projects = mergeProjectSummaries(saved.filter(project => aliases.get(canonicalPath(project.path)) === project.path),
				disk.map(project => ({ ...project, path: aliases.get(canonicalPath(project.path)) ?? project.path })), new Set(removed));
			this.store.rememberDisplayedProjects(this.clientId, projects);
			this.emit({ type: "projects", projects });
		} catch { if (!this.disposed) this.emitNotice("error", "OMP 项目历史读取失败，请稍后重试"); }
		finally { this.lastActivityAt = Date.now(); }
	}
	async pushSettings() {
		const session = this.session, response = await session.readMetadata("get_state"), resources = await session.readMetadata("harness_resources");
		if (this.session !== session) return;
		const views = isRecord(resources?.data) ? resources.data : {};
		this.emit({ type: "settings_state", settings: { ...this.store.getSettings(this.clientId), disabledPlugins: this.store.getSettings(this.clientId).disabledPlugins ?? [], effectiveSystemPrompt: systemPromptText(response?.data), skills: views.skills as UiSettingsState["skills"], extensions: views.extensions as UiSettingsState["extensions"] } });
	}
	async nativeResources(action: "omp-resources" | "omp-reload" | "omp-save-skills", payload: { version?: unknown; patch?: unknown } = {}) {
		const chat = this.chat;
		const valid = () => !this.disposed && this.chat === chat && !this.switchingWorkspace;
		const read = async () => {
			const response = await chat.session.requestIfOpen("harness_resources");
			if (!valid()) throw Error("Conversation changed");
			if (!response) return { available: false, agentDir: "", skills: [], extensions: [], tools: [] };
			if (!isRecord(response.data)) throw Error("Native resources unavailable");
			return { available: true, ...response.data, tools: chat.session.state.tools ?? [] };
		};
		if (action === "omp-resources") return read();
		return this.navigation.run(valid, async assertCurrent => {
			if (this.isQuiesced() || chat.session.state.running) throw Error("Stop the current task before changing resources");
			if (action === "omp-reload") await chat.session.reloadResources(assertCurrent);
			else {
				await chat.session.command("harness_save_skills", payload, { open: false });
			}
			assertCurrent(); await chat.session.refresh(); assertCurrent();
			await this.pushSettings(); assertCurrent(); await this.pushSlashCommands(); assertCurrent();
			return read();
		});
	}
	/** Fixed host-owned OMP directory; no agent startup or native code execution. */
	extensionDirectory(prepare: boolean) {
		if (this.disposed || this.switchingWorkspace || prepare && this.isQuiesced()) throw Error("Extension directory unavailable");
		const path = resolve(this.store.dataDir, "omp", "agent", "extensions");
		if (prepare) mkdirSync(path, { recursive: true });
		return path;
	}
	async nativeExtensions(payload: Record<string, unknown>) {
		const chat = this.chat;
		const reading = payload.action === "get" || payload.action === "read-file";
		const valid = () => !this.disposed && this.chat === chat && !this.switchingWorkspace;
		const execute = async (assertCurrent: () => void) => {
			if (!reading && (this.isQuiesced() || chat.session.state.running)) throw Error("Stop the current task before changing extensions");
			if (payload.action === "restart") await chat.session.reloadResources(assertCurrent);
			const response = ["save", "toggle", "save-file"].includes(String(payload.action))
				? await chat.session.command("harness_extensions", payload, { open: false })
				: await chat.session.requestIfOpen("harness_extensions", payload.action === "restart" ? { action: "get" } : payload);
			assertCurrent();
			if (!response) {
				if (payload.action !== "get") throw Error("Extension worker stopped; reload explicitly to continue");
				return { available: false, version: "", settings: [], modules: [], restartRequired: false };
			}
			if (!isRecord(response.data)) throw Error("Extension state unavailable");
			if (typeof response.data.extensionError === "string") throw Error(response.data.extensionError);
			if (!reading && payload.action !== "save-file") { await chat.session.refresh(); assertCurrent(); await this.pushSettings(); assertCurrent(); await this.pushSlashCommands(); assertCurrent(); }
			return response.data;
		};
		if (reading) return execute(() => { if (!valid()) throw Error("Conversation changed"); });
		return this.navigation.run(valid, execute);
	}
	async changePackageSettings<T>(operation: () => Promise<T>) {
		const chat = this.chat;
		return this.navigation.run(() => !this.disposed && this.chat === chat && !this.switchingWorkspace, async assertCurrent => {
			if (this.isQuiesced() || chat.session.state.running) throw Error("Stop the current task before changing package settings");
			const result = await operation(); assertCurrent(); return result;
		});
	}
	async nativeMcp(payload: Record<string, unknown>) {
		const chat = this.chat;
		const valid = () => !this.disposed && this.chat === chat && !this.switchingWorkspace;
		const readOnly = payload.action === "get" || payload.action === "status";
		const execute = async (assertCurrent: () => void) => {
			if (!readOnly && (this.isQuiesced() || chat.session.state.running)) throw Error("Stop the current task before changing MCP");
			const response = payload.action === "reload" ? await chat.session.command("harness_mcp", payload) : await chat.session.requestIfOpen("harness_mcp", payload);
			assertCurrent();
			if (!response) {
				if (!readOnly) throw Error("MCP worker stopped; reload explicitly to continue");
				return { workerAvailable: false, available: false, reloadRequired: false, servers: [] };
			}
			if (!isRecord(response.data)) throw Error("MCP state unavailable");
			if (typeof response.data.mcpError === "string") throw Error(response.data.mcpError);
			if (!readOnly) { await chat.session.refresh(); assertCurrent(); await this.pushSettings(); assertCurrent(); await this.pushSlashCommands(); assertCurrent(); }
			return response.data;
		};
		if (readOnly) return execute(() => { if (!valid()) throw Error("Conversation changed"); });
		return this.navigation.run(valid, execute);
	}
	async nativeSessions(): Promise<(SessionSummary & { id: string })[]> {
		const response = await this.session.readMetadata("harness_list_sessions");
		if (!response) return [];
		if (!isRecord(response.data) || !Array.isArray(response.data.sessions)) throw Error("Invalid OMP history response");
		return response.data.sessions as (SessionSummary & { id: string })[];
	}
	async refreshSessions() { this.emit({ type: "sessions", cwd: this.cwd, sessions: await this.nativeSessions() }); }
	async switchSession(path: string) {
		this.navigation.assertAvailable();
		const initial = this.chat;
		if (!(await this.nativeSessions()).some(session => realpathSync(session.path) === realpathSync(path))) throw Error("Session is not an OMP history in this workspace");
		this.navigation.assertAvailable();
		if (this.chat !== initial || this.switchingWorkspace) throw Error("Conversation changed");
		const existing = [...this.chats.values()].find(chat => chat.session.state.sessionFile && realpathSync(chat.session.state.sessionFile) === realpathSync(path));
		if (existing) return this.switchConversation(existing.id);
		this.switchingWorkspace = true;
		try { await this.createChat(this.cwd, this.activeIsWiki, path); }
		finally { this.switchingWorkspace = false; this.flushSnapshot(); }
	}
	async deleteSession(path: string, options: { replaceActive?: boolean } = {}) {
		let current = this.chat;
		return this.navigation.run(() => !this.disposed && this.chat === current && !this.switchingWorkspace, async assertCurrent => {
			if (this.isQuiesced()) throw new QuiesceRejectedError("Service draining");
			const file = realpathSync(path);
			const target = (await this.nativeSessions()).find(session => realpathSync(session.path) === file);
			assertCurrent();
			if (!target) throw Error("Unknown OMP session");
			const chat = [...this.chats.values()].find(chat => chat.session.state.sessionId === target.id);
			if (chat?.id === this.activeId && !options.replaceActive) throw new SessionInUseError("此会话正在使用中，请先切换到其他会话");
			const terminals = chat?.terminals.list().filter(terminal => terminal.running) ?? [];
			if (terminals.length) throw new SessionInUseError(`此会话有运行中的终端：${terminals.map(terminal => terminal.title).join("、")}`);
			if (chat?.session.busy) throw new SessionInUseError("此会话仍有后台任务或待处理请求，请先等待完成或停止任务");
			const release = this.reserveSessionDeletion(file);
			if (chat) this.deletingChats.add(chat.id);
			try {
				if (chat?.id === this.activeId) {
					this.switchingWorkspace = true;
					try { await this.createChat(chat.cwd, chat.wiki); current = this.chat; }
					finally { this.switchingWorkspace = false; }
					assertCurrent();
				}
				if (chat) await chat.session.close();
				assertCurrent();
				if (this.isQuiesced()) throw new QuiesceRejectedError("Service draining");
				const journal = new OmpPersistenceJournal(join(this.store.dataDir, "omp"));
				const acknowledged = journal.read(file).tokens;
				await deleteOmpHistory({ dataDir: this.store.dataDir, cwd: current.cwd, kind: current.wiki ? "wiki" : "chat", sessionFile: file });
				journal.clear(file, acknowledged);
				if (chat) {
					forgetDatabaseScope(databaseScope(this.clientId, chat.cwd, chat.session.sessionManager));
					chat.terminals.killAll(); this.chats.delete(chat.id);
				}
				await this.refreshSessions();
			} finally { if (chat) this.deletingChats.delete(chat.id); release(); }
		});
	}
	async nativePrompt(payload: Record<string, unknown>) {
		const chat = this.chat;
		const valid = () => !this.disposed && this.chat === chat && !this.switchingWorkspace;
		const readOnly = payload.action === "get" || payload.action === "read";
		const execute = async (assertCurrent: () => void) => {
			if (!readOnly && (this.isQuiesced() || chat.session.state.running)) throw Error("Stop the current task before changing prompt files");
			const response = payload.action === "reload" ? await chat.session.command("harness_prompt", payload) : await chat.session.requestIfOpen("harness_prompt", payload);
			assertCurrent();
			if (!response) {
				if (payload.action !== "get") throw Error("Prompt worker stopped; reload explicitly to continue");
				return { available: false, blocks: [], sources: [], files: [], reloadRequired: false };
			}
			if (!isRecord(response.data)) throw Error("Prompt state unavailable");
			if (typeof response.data.promptError === "string") throw Error(response.data.promptError);
			if (payload.action === "reload") { await chat.session.refresh(); assertCurrent(); await this.pushSettings(); assertCurrent(); await this.pushSlashCommands(); assertCurrent(); }
			return response.data;
		};
		if (readOnly) return execute(() => { if (!valid()) throw Error("Conversation changed"); });
		return this.navigation.run(valid, execute);
	}
	async listModelsConfig() {
		const response = await this.session.command("harness_models_config");
		if (!isRecord(response.data) || !Array.isArray(response.data.providers)) throw Error("Invalid OMP model configuration response");
		this.emit({ type: "models_config", providers: response.data.providers as UiProviderConfig[] });
	}
	private async modelCatalog(message: Extract<ClientMessage, { type: "fetch_models" | "refresh_provider_models" | "clone_provider" }>) {
		const type = message.type === "fetch_models" ? "fetch_models_result" : message.type === "clone_provider" ? "clone_provider_result" : "refresh_provider_result";
		const session = this.session;
		let errorMessage = "OMP 模型目录操作失败，请检查服务地址、认证与协议，并在任务结束后重试";
		try {
			if (!Number.isSafeInteger(message.reqId)) throw Error("请求 ID 无效");
			if (message.type === "refresh_provider_models") {
				this.navigation.assertAvailable();
				if (session.state.running) throw Error("请等待当前任务结束");
			}
			const { type: _type, reqId: _reqId, ...payload } = message;
			const command = message.type === "fetch_models" ? "harness_fetch_models" : message.type === "clone_provider" ? "harness_clone_provider" : "harness_refresh_provider";
			const response = await session.command(command, payload);
			if (!isRecord(response.data)) throw Error("OMP 模型目录响应无效");
			// Only the host worker's own sanitized catalogue errors cross this boundary.
			if (typeof response.data.catalogError === "string") { errorMessage = response.data.catalogError; throw Error("Catalog operation failed"); }
			if (type === "fetch_models_result") {
				if (!Array.isArray(response.data.models)) throw Error("OMP 模型目录响应无效");
				this.emit({ type, reqId: message.reqId, ok: true, models: response.data.models as UiProviderConfig["models"] });
			} else if (type === "clone_provider_result") {
				if (!isRecord(response.data.config)) throw Error("OMP 模型目录响应无效");
				this.emit({ type, reqId: message.reqId, ok: true, config: response.data.config as unknown as UiProviderConfig });
				const config = response.data.config as unknown as UiProviderConfig;
				this.emit({ type: "notice", level: "info", text: `已生成 ${config.providerId} 草稿（${config.api}，${config.models.length} 个模型），请填写新的 API 密钥后保存` });
			} else {
				if (typeof response.data.added !== "number" || typeof response.data.total !== "number") throw Error("OMP 模型目录响应无效");
				this.emit({ type, reqId: message.reqId, ok: true, added: response.data.added, total: response.data.total });
				this.emit({ type: "notice", level: "info", text: `已刷新模型列表：新增 ${response.data.added} 个，共 ${response.data.total} 个` });
				await Promise.allSettled([this.listModelsConfig(), this.listModels()]);
			}
		} catch {
			this.emit({ type, reqId: message.reqId, ok: false, error: errorMessage });
			if (type !== "fetch_models_result") this.emit({ type: "notice", level: "error", text: errorMessage });
		}
	}
	private async providers() {
		const response = await this.session.command("harness_providers");
		if (!isRecord(response.data) || !Array.isArray(response.data.providers)) throw Error("Invalid OMP providers response");
		const login = await this.session.command("get_login_providers");
		const available = isRecord(login.data) && Array.isArray(login.data.providers) ? login.data.providers.filter(isRecord) : [];
		this.emit({ type: "providers_status", providers: (response.data.providers as ProviderStatus[]).map(provider => ({ ...provider, oauth: available.some(item => item.id === provider.id && item.available === true) })) });
	}
	async listToolOutputs(conversationId: string, toolCallId: string, taskId?: string) {
		const { output } = await this.toolOutput(conversationId, toolCallId, taskId);
		return output.artifacts.length ? output.artifacts.map(({ id, name, default: isDefault, partial }) => ({ id, name, default: isDefault, partial })) : [{ id: "text", name: "tool-output.txt", default: true }];
	}
	private async toolOutput(conversationId: string, toolCallId: string, taskId?: string) {
		const chat = this.chats.get(conversationId), file = chat?.session.state.sessionFile;
		if (!chat || !file || !toolCallId || toolCallId.length > 2000) throw outputDenied();
		const taskPath = () => { try { return taskId === undefined ? undefined : chat.session.taskOutputPath(taskId); } catch { throw outputDenied(); } };
		const outputTask = taskPath();
		const output = await readOmpToolOutput({ dataDir: this.store.dataDir, cwd: chat.cwd, kind: chat.wiki ? "wiki" : "chat", sessionFile: file, outputTask }, toolCallId);
		if (this.disposed || this.chats.get(conversationId) !== chat || chat.session.state.sessionFile !== file) throw outputDenied();
		if (JSON.stringify(taskPath()) !== JSON.stringify(outputTask)) throw outputDenied();
		return { file, output };
	}
	async downloadToolOutput(conversationId: string, toolCallId: string, outputId?: string, taskId?: string) {
		const { file, output } = await this.toolOutput(conversationId, toolCallId, taskId);
		const artifact = outputId ? output.artifacts.find(item => item.id === outputId) : output.artifacts.find(item => item.default);
		if (artifact) return { name: artifact.name, handle: await openOmpArtifact(file, artifact.path) };
		if (outputId && outputId !== "text") throw outputDenied();
		return { name: "tool-output.txt", handle: { createReadStream: () => Readable.from([output.text]) } };
	}

	ownsSessionFile(file: string) { return [...this.chats.values()].some(chat => chat.session.state.sessionFile && canonicalPath(chat.session.state.sessionFile) === file); }
	ownsSession(sessionId: string) { return [...this.chats.values()].some(chat => chat.session.state.sessionId === sessionId); }
	activeConversations() { return [...this.chats.values()].filter(chat => chat.session.busy || chat.id === this.activeId && this.navigation.busy).length; }
	pendingMessages() { return [...this.chats.values()].reduce((sum, chat) => sum + (chat.session.state.queue?.steering.length ?? 0) + (chat.session.state.queue?.followUp.length ?? 0), 0); }
	private cancelBranchSummary(message: Extract<TreeRequest, { type: "tree_cancel_summary" }>) {
		if (![message.reqId, message.conversationId, message.operationId].every(value => typeof value === "string" && value.length > 0 && value.length <= 2000)) throw Error("Invalid summary cancellation request");
		const operation = this.branchSummary;
		if (this.disposed || !operation || operation.done || this.chats.get(operation.chat.id) !== operation.chat || operation.id !== message.operationId || operation.chat.id !== message.conversationId || this.chat !== operation.chat || operation.chat.session.generation !== operation.generation) {
			this.emit({ type: "tree_cancel_result", conversationId: message.conversationId, reqId: message.reqId, status: "stale" }); return;
		}
		if (!operation.cancelling) {
			operation.cancelling = true;
			// abort_branch_summary overtakes native navigate_tree. It may arrive
			// before the native abort controller exists, so repeat only cancellation
			// while this exact operation and worker remain in flight. Never retry
			// navigation or a model request. Drain the final acknowledgement before
			// releasing the navigation lease so it cannot cancel a successor.
			operation.cancellation = (async () => {
				try {
					while (!operation.done && this.branchSummary === operation && operation.chat.session.generation === operation.generation) {
						const response = await operation.chat.session.requestIfOpen("abort_branch_summary");
						if (!response || operation.done) break;
						await new Promise<void>(resolve => {
							const timer = setTimeout(() => { operation.wake = undefined; resolve(); }, 100);
							operation.wake = () => { clearTimeout(timer); operation.wake = undefined; resolve(); };
						});
					}
				} catch {
					if (!operation.done) {
						operation.cancelling = false;
						this.emit({ type: "notice", level: "error", conversationId: operation.chat.id, text: "无法确认摘要取消，请检查当前会话；必要时使用停止。" });
						this.flushSnapshot();
					}
				}
			})();
			this.flushSnapshot();
		}
		this.emit({ type: "tree_cancel_result", conversationId: message.conversationId, reqId: message.reqId, status: "requested" });
	}
	private async navigateTree(chat: Chat, message: Extract<TreeRequest, { type: "tree_navigate" }>, assertCurrent: () => void) {
		assertCurrent(); await chat.session.open(); assertCurrent();
		const operation: BranchSummaryOperation | undefined = message.summary !== "none" ? { id: randomUUID(), requestId: message.reqId, chat, generation: chat.session.generation, done: false, cancelling: false } : undefined;
		if (operation) { this.branchSummary = operation; this.flushSnapshot(); }
		try {
			return await chat.session.command("navigate_tree", { entryId: message.targetId, summarize: message.summary !== "none", customInstructions: message.summary === "custom" ? message.customInstructions : undefined }, { open: false });
		} finally {
			if (operation) {
				operation.done = true; operation.wake?.(); await operation.cancellation;
				if (this.branchSummary === operation) this.branchSummary = undefined;
				this.flushSnapshot();
			}
		}
	}

	private async handleTree(message: TreeRequest) {
		if (message.type === "tree_cancel_summary") { this.cancelBranchSummary(message); return; }
		if (message.conversationId !== this.conversationId) throw Error("Conversation changed");
		const chat = this.chat, session = chat.session, conversationId = chat.id;
		const readOnly = message.type === "tree_get" || message.type === "tree_content" || message.type === "tree_preview";
		const execute = async (assertCurrent: () => void) => {
			// Reject invalid options before stopping a running task or opening a worker.
			if (message.type === "tree_navigate") {
				if (!["none", "default", "custom"].includes(message.summary)) throw Error("Invalid summary mode");
				if (message.replaceInstructions) throw Error("OMP does not support replacing its native summary instructions");
				if (message.summary === "custom" && (typeof message.customInstructions !== "string" || !message.customInstructions.trim() || message.customInstructions.length > 16000)) throw Error("Custom summary instructions must contain 1–16000 characters");
			}
			if (message.type === "session_reopen") {
				if (this.isQuiesced() || session.isStreaming) throw new OmpNavigationBusyError();
				await session.reopen(assertCurrent); assertCurrent(); this.persist(); this.flushSnapshot();
				this.emit({ type: "tree_navigate_result", conversationId, reqId: message.reqId, status: "ok" }); return;
			}
			if (!readOnly) session.assertWritable();
			const tree = await readTree(session, message.type === "tree_get" ? message.filter : "all", message.type === "tree_get" ? message.query : "", message.type === "tree_preview" ? message.targetId : undefined);
			assertCurrent();
			if (message.type === "tree_get") { this.emit({ type: "tree", conversationId, reqId: message.reqId, revision: tree.revision, leafId: tree.leafId, nodes: tree.nodes, truncated: tree.truncated }); return; }
			if (message.type === "tree_content") {
				const entry = tree.byId.get(message.entryId); if (!entry) throw Error("Unknown tree entry");
				const projected = projectMessage(nativeEntryMessage(entry), 0, message.entryId);
				const content = projected ? JSON.stringify(projected.content, null, 2) : typeof entry.summary === "string" ? entry.summary : typeof entry.label === "string" ? entry.label : String(entry.type);
				this.emit({ type: "tree_content_result", conversationId, reqId: message.reqId, entryId: message.entryId, content: content.slice(0, 200000), toolCallId: projected?.toolCallId }); return;
			}
			if (message.type === "tree_preview") {
				if (!tree.byId.has(message.targetId)) throw Error("Unknown tree entry");
				if (!tree.preview) throw Error("Native summary preview unavailable");
				this.emit({ type: "tree_preview_result", conversationId, reqId: message.reqId, ...tree.preview }); return;
			}
			if (this.isQuiesced()) throw Error("Service draining");
			if ("targetId" in message && !tree.byId.has(message.targetId) || "entryId" in message && !tree.byId.has(message.entryId)) throw Error("Unknown tree entry");
			if (session.isStreaming && message.type !== "tree_label") {
				if (message.type === "tree_navigate" && message.abortRunning) { await session.stop(); assertCurrent(); }
				else throw new OmpNavigationBusyError();
			}
			let editorText: string | undefined;
			if (message.type === "tree_label") {
				if (message.label !== null && (typeof message.label !== "string" || message.label.length > 200)) throw Error("Label must be at most 200 characters");
				await session.command("set_label", { entryId: message.entryId, label: message.label?.trim() || undefined });
			} else if (message.type === "session_clone") await session.command("fork");
			else if (message.type === "session_fork") {
				const entry = tree.byId.get(message.entryId)!;
				const entryId = message.position === "before" ? entry.parentId : message.entryId;
				if (typeof entryId !== "string") throw Error("Cannot fork before the root entry");
				await session.command("fork", { entryId });
			} else if (message.type === "tree_navigate") {
				const response = await this.navigateTree(chat, message, assertCurrent);
				assertCurrent();
				if (isRecord(response.data) && (response.data.aborted || response.data.cancelled)) { this.emit({ type: "tree_navigate_result", conversationId, reqId: message.reqId, status: response.data.aborted ? "aborted" : "cancelled" }); return; }
				if (isRecord(response.data) && typeof response.data.editorText === "string") editorText = response.data.editorText;
				if (message.label) await session.command("set_label", { entryId: message.targetId, label: message.label.slice(0, 200) });
			}
			assertCurrent(); await session.refresh(); assertCurrent(); this.persist(); this.flushSnapshot();
			this.emit({ type: "tree_navigate_result", conversationId, reqId: message.reqId, status: "ok", editorText });
		};
		if (readOnly) await execute(() => { if (this.disposed || !this.chats.has(conversationId)) throw Error("Conversation unavailable"); });
		else await this.navigation.run(() => !this.disposed && this.chat === chat && !this.switchingWorkspace, execute);
	}
	async handle(message: ClientMessage) {
		// App version lookup has no conversation state or side effects. A closed
		// window may hand its history off while this optional network read runs.
		const ownsConversation = message.type !== "check_update";
		if (ownsConversation) this.pendingOperations++;
		try {
			switch (message.type) {
				case "tree_cancel_summary": case "tree_get": case "tree_content": case "tree_preview": case "tree_navigate": case "tree_label": case "session_clone": case "session_fork": case "session_reopen": await this.handleTree(message); break;
				case "edit_message": {
					if (message.conversationId && message.conversationId !== this.conversationId) throw Error("Conversation changed");
					const chat = this.chat, session = chat.session;
					await this.navigation.run(() => !this.disposed && this.chat === chat && !this.switchingWorkspace, async (assertCurrent, lease) => {
						session.assertWritable();
						if (this.isQuiesced()) throw Error("Service draining");
						if (session.isStreaming) throw new OmpNavigationBusyError();
						const entryId = message.entryId ?? session.state.messages.find(item => item.id === message.messageId && item.role === "user")?.entryId;
						if (!entryId || !session.state.messages.some(item => item.entryId === entryId && item.role === "user")) throw Error("Message is not a native editable entry");
						const prepared = await this.preparePrompt(chat, message.text, message.attachments, assertCurrent);
						assertCurrent();
						const response = await session.command("navigate_tree", { entryId, summarize: false });
						assertCurrent();
						if (isRecord(response.data) && (response.data.cancelled || response.data.aborted)) throw Error("Edit navigation cancelled");
						if (message.newSession ?? this.store.getSettings(this.clientId).editResendNewSession) { await session.command("fork"); assertCurrent(); }
						await session.refresh(); assertCurrent();
						await this.prompt(message.text, message.attachments, undefined, undefined, undefined, { conversationId: chat.id, cwd: chat.cwd, sessionId: session.state.sessionId }, lease, prepared);
					});
					break;
				}
				case "check_update": {
					const current = appVersion();
					try { const response = await fetch("https://registry.npmjs.org/@youweichen%2fpi-harness/latest", { signal: AbortSignal.any([AbortSignal.timeout(5000), this.passiveRequests.signal]) }); const value: unknown = await response.json(); const latest = isRecord(value) && typeof value.version === "string" ? value.version : null; this.emit({ type: "update_status", current, latest, latestPublishedAt: null, upToDate: latest === current }); }
					catch { this.emit({ type: "update_status", current, latest: null, latestPublishedAt: null, upToDate: false, error: "Update check unavailable" }); } break;
				}
				case "extensions_reload": await this.nativeResources("omp-reload"); break;
				case "prompt": await this.prompt(message.text, message.attachments, message.queue, message.requestId, undefined, message.target); break;
				case "query_prompt_receipt": this.emit(this.queryPromptReceipt(message.requestId)); break;
				case "abort": await this.abort(); break;
				case "new_chat": await this.newChat(); break;
				case "get_state": await this.session.refresh(); this.flushSnapshot(true); break;
				case "omp_task_request": {
					const chat = this.chats.get(message.conversationId);
					try {
						if (!chat || typeof message.requestId !== "string" || message.requestId.length > 200 || typeof message.taskId !== "string" || !["detail", "stop"].includes(message.action)) throw Error("Invalid task request");
						if (message.action === "stop" && this.isQuiesced()) throw Error("Server is stopping");
						const result = await chat.session.taskRequest(message.taskId, message.action, message.cursor);
						if ("messages" in result && result.messages) result.messages = result.messages.map(item => item.role === "toolResult" && item.toolCallId ? { ...item,
							toolOutputUrl: `/api/tool-output?${new URLSearchParams({ clientId: this.clientId, conversationId: chat.id, taskId: message.taskId, toolCallId: item.toolCallId })}` } : item);
						this.emit({ type: "omp_task_response", requestId: message.requestId, conversationId: chat.id, taskId: message.taskId, ...result });
					} catch { this.emit({ type: "omp_task_response", requestId: message.requestId, conversationId: message.conversationId, taskId: message.taskId, error: "OMP task unavailable in this conversation; the worker or branch may have changed" }); }
					break;
				}
				case "set_cwd": await this.setCwd(message.path, message.requestId, message.source === "ui" ? "ui" : "command"); break;
				case "switch_conversation": await this.switchConversation(message.id); break;
				case "list_models": await this.listModels(); break;
				case "set_model": await this.setModel(message.modelId); break;
				case "set_thinking": this.navigation.assertAvailable(); await this.session.setThinking(message.level); break;
				case "cycle_model": this.navigation.assertAvailable(); await this.session.command("cycle_model"); await this.session.refresh(); break;
				case "cycle_thinking": this.navigation.assertAvailable(); await this.session.command("cycle_thinking_level"); await this.session.refresh(); break;
				case "get_commands": await this.pushSlashCommands(); break;
				case "list_sessions": await this.refreshSessions(); break;
				case "switch_session": await this.switchSession(message.path); break;
				case "delete_session": await this.deleteSession(message.path); break;
				case "rename_session": await this.session.command("harness_rename_session", { path: message.path, name: message.name }); await this.session.refresh(); await this.refreshSessions(); break;
				case "list_models_config": await this.listModelsConfig(); break;
				case "list_providers": await this.providers(); break;
				case "fetch_models": case "refresh_provider_models": case "clone_provider": await this.modelCatalog(message); break;
				case "save_model_config": await this.session.command("harness_save_provider", { providerId: message.providerId, config: message.config }); await this.listModelsConfig(); await this.listModels(); break;
				case "delete_model_config": await this.session.command("harness_delete_provider", { providerId: message.providerId }); await this.listModelsConfig(); await this.listModels(); break;
				case "logout_provider": await this.session.command("harness_logout", { providerId: message.provider }); await this.listModels(); await this.providers(); break;
				case "login_provider": await this.auth.login(message.provider); await this.listModels(); await this.providers(); break;
				case "cancel_provider_login": await this.auth.cancel(message.requestId); break;
				case "provider_auth_response": this.auth.respond(message.requestId, message.promptId, message.value); break;
				case "clear_provider_api_key": await this.session.command("harness_clear_key", { providerId: message.provider }); await this.listModels(); await this.providers(); break;
				case "set_provider_api_key": await this.session.command("harness_set_key", { providerId: message.provider, apiKey: message.apiKey }); await this.listModels(); await this.providers(); break;
				case "dialog_response": this.extensionUi.reply(message, this.activeId, this.session.generation, frame => this.session.reply(frame)); break;
				case "get_settings": await this.pushSettings(); break;
				case "set_settings": this.store.saveSettings(this.clientId, message); await this.pushSettings(); break;
				case "list_projects": this.pushProjects(); break;
				case "remove_project": this.store.removeProject(this.clientId, message.path); this.pushProjects(); break;
				case "browse_dirs": await browseDirs(message.path, event => this.emit(event)); break;
				case "list_files": await this.files.listFiles(message.path); break;
				case "read_file": await this.files.readFile(message.path, message); break;
				case "write_file": await this.files.writeFile(message.path, message.text, message); break;
				case "search_files": await this.files.searchFiles(message.query, message.reqId); break;
				case "search_content": this.search.search(this.cwd, message.reqId, message); break;
				case "complete_path": await this.files.completePath(message.path); break;
				case "get_git_branch": await this.files.gitBranch(); break;
				case "scm_status": await this.files.scmQuery("status", message.reqId); break;
				case "scm_diff": await this.files.scmQuery("diff", message.reqId, message); break;
				case "scm_history": await this.files.scmQuery("history", message.reqId); break;
				case "scm_filediff": await this.files.scmQuery("filediff", message.reqId, message); break;
				case "scm_commit": await this.files.scmQuery("commit", message.reqId, message); break;
				case "check_conversation_files": this.emit({ type: "conversation_files_checked", cwd: message.cwd, reqId: message.reqId, paths: existingConversationFiles(this.cwd, message.paths) }); break;
				case "terminal_create":
					if (this.isQuiesced()) throw new QuiesceRejectedError("Service draining");
					this.getTerminalManager(message.conversationId)?.create(message.terminalId, message.cwd, message.cols, message.rows, this.getTerminalCwd(message.conversationId)); break;
				case "terminal_input": this.getTerminalManager(message.conversationId)?.input(message.terminalId, message.data); break;
				case "terminal_resize": this.getTerminalManager(message.conversationId)?.resize(message.terminalId, message.cols, message.rows); break;
				case "terminal_kill": this.getTerminalManager(message.conversationId)?.kill(message.terminalId); break;
				case "terminal_rename": this.getTerminalManager(message.conversationId)?.rename(message.terminalId, message.title); break;
				case "run_command":
					if (this.isQuiesced()) throw new QuiesceRejectedError("Service draining");
					this.getTerminalManager(message.conversationId)?.runCommand(message.terminalId, message.command, message.cols, message.rows, this.getTerminalCwd(message.conversationId)); break;
				case "terminal_replay": { const output = this.getTerminalManager(message.conversationId)?.replay().find(item => item.terminalId === message.terminalId); if (output) this.emit({ type: "terminal_output", conversationId: message.conversationId, ...output, reset: true }); break; }
				case "list_commands": this.emit({ type: "commands", cwd: this.cwd, ...await loadCommands(this.cwd) }); break;
				case "save_commands": { const result = await saveCommandsFile(this.cwd, message.commands); if (result.error) throw Error(result.error); this.emit({ type: "commands", cwd: this.cwd, ...await loadCommands(this.cwd) }); break; }
				case "set_cache_warming": await this.session.command("set_cache_warming", { mode: message.mode }); await this.session.refresh(); break;
				case "get_cache_warming": if (message.conversationId === this.conversationId) await this.session.refresh(); break;
				case "recall_queue": {
					if (message.conversationId !== this.conversationId) throw Error("Conversation changed");
					const session = this.session;
					await this.recalls.recall(message.conversationId, message.requestId, () => session.recallQueue());
					await session.refresh(); break;
				}
				case "queue_recall_ack": this.recalls.acknowledge(message.conversationId, message.requestId); break;
				case "cancel_recovery": if (message.conversationId !== this.conversationId) throw Error("Conversation changed"); await this.session.cancelRecovery(message.operationId); break;
				case "set_run_settings": if (message.conversationId !== this.conversationId) throw Error("Conversation changed"); await this.session.setRunSettings(message); break;
				default: throw Error(`OMP integration does not yet handle ${message.type}`);
			}
		} catch (error) {
			this.emitNotice(error instanceof SessionInUseError ? "warning" : "error", (error as Error).message);
			if (["tree_navigate", "tree_label", "session_clone", "session_fork", "session_reopen"].includes(message.type) && "reqId" in message && "conversationId" in message && typeof message.conversationId === "string") this.emit({ type: "tree_navigate_result", conversationId: message.conversationId, reqId: message.reqId, status: error instanceof OmpNavigationBusyError ? "busy" : "error", error: (error as Error).message });
		} finally { if (ownsConversation) this.pendingOperations--; this.lastActivityAt = Date.now(); }
	}
	async dispose() {
		this.persist(); this.disposed = true; this.navigation.cancel(); clearTimeout(this.timer);
		this.passiveRequests.abort();
		await this.projectsRead;
		await this.auth.close();
		this.files.unwatchDir(); this.files.unwatchGit(); this.search.cancel();
		await Promise.all([...this.chats.values()].map(async chat => { forgetDatabaseScope(databaseScope(this.clientId, chat.cwd, chat.session.sessionManager)); chat.terminals.killAll(); await chat.session.close(); }));
		this.chats.clear(); this.sinks.clear();
	}
}

export class OmpChatService {
	private clients = new Map<string, OmpClientSession>();
	private pending = new Map<string, Promise<OmpClientSession>>();
	private retiring = new Map<string, Promise<void>>();
	private deletingFiles = new Set<string>();
	private idleSince = new Map<string, number>();
	private evictionTimer?: ReturnType<typeof setInterval>;
	private closed = false;
	private store: ClientStateStore;
	readonly wikiConversations: OmpWikiConversations;
	readonly packages: OmpPackages;
	onToolEvent?: (event: PluginToolEvent) => void;
	onQuit?: () => boolean;
	private paused = false;
	private pausedAt = 0;
	private sockets = 0;
	onClientCwdChanged?: (cwd: string) => void;
	constructor(private cwd: string, stateFile: string) {
		this.store = new ClientStateStore(stateFile); this.wikiConversations = new OmpWikiConversations(this, this.store.dataDir); this.packages = new OmpPackages(this.store.dataDir);
		const configured = Number(process.env.PI_WEB_CLIENT_IDLE_MINUTES ?? 30);
		const idleMs = (Number.isFinite(configured) && configured >= 0 ? configured : 30) * 60_000;
		if (idleMs > 0) {
			this.evictionTimer = setInterval(() => this.evictIdle(idleMs), Math.min(30_000, Math.max(100, idleMs / 2)));
			this.evictionTimer.unref();
		}
	}
	get(clientId: string) { return this.retiring.has(clientId) ? undefined : this.clients.get(clientId); }
	private evictIdle(idleMs: number) {
		const now = Date.now();
		for (const [id, client] of this.clients) {
			if (this.closed || this.pending.has(id) || this.retiring.has(id) || this.packages.activeCount() || !client.canEvict) { this.idleSince.delete(id); continue; }
			const since = this.idleSince.get(id);
			if (since === undefined) this.idleSince.set(id, now);
			else if (now - Math.max(since, client.lastActivityAt) >= idleMs) void this.retire(id, client).catch(() => console.error("OMP idle client cleanup failed; automatic reattachment is blocked until service restart"));
		}
	}
	private retire(id: string, client: OmpClientSession): Promise<void> {
		const previous = this.retiring.get(id); if (previous) return previous;
		// Keep ownership until every worker has closed. Reconnects wait here rather
		// than opening a second worker against the same native history file.
		const closing = Promise.resolve().then(() => client.dispose()).then(() => {
			if (this.clients.get(id) === client) this.clients.delete(id);
			this.retiring.delete(id); this.idleSince.delete(id);
		});
		this.retiring.set(id, closing);
		return closing;
	}
	async attach(clientId: string, send: Sink, wikiCwd?: string, wiki = false) {
		const retiring = this.retiring.get(clientId); if (retiring) await retiring;
		if (this.closed) throw new QuiesceRejectedError("Service draining");
		this.idleSince.delete(clientId);
		let client = this.clients.get(clientId);
		if (!client) {
			if (this.paused) throw new QuiesceRejectedError("Service draining");
			let pending = this.pending.get(clientId);
			if (!pending) {
				pending = (async () => {
					const saved = this.store.get(clientId).lastCwd;
					const cwd = wikiCwd ?? (saved && existsSync(saved) ? saved : this.cwd);
					const created = new OmpClientSession(clientId, cwd, this.store);
					this.clients.set(clientId, created); created.attachSink(send, false);
					created.isQuiesced = () => this.paused;
					created.onCwdChanged = next => this.onClientCwdChanged?.(next);
					created.onToolEvent = event => this.onToolEvent?.(event);
					created.assertSessionAvailable = file => { if (this.deletingFiles.has(file)) throw new SessionInUseError("正在删除此会话，请稍后重试"); };
					created.reserveSessionDeletion = file => {
						created.assertSessionAvailable(file);
						if ([...this.clients.values()].some(client => client !== created && client.ownsSessionFile(file))) throw new SessionInUseError("此会话仍被其他窗口使用，请先关闭该会话");
						this.deletingFiles.add(file);
						return () => { this.deletingFiles.delete(file); };
					};
					// Library configuration can arrive after hello. Window identity must
					// not depend on already knowing its directory (legacy URLs still work).
					try { await created.initialize(wiki || !!wikiCwd); this.clients.set(clientId, created); return created; }
					catch (error) { this.clients.delete(clientId); await created.dispose(); throw error; }
				})().finally(() => this.pending.delete(clientId));
				this.pending.set(clientId, pending);
			}
			client = await pending;
		}
		const opening = this.pending.get(clientId); if (opening) await opening;
		client.attachSink(send); return client;
	}
	detach(clientId: string, send: Sink) { this.clients.get(clientId)?.detachSink(send); }
	noteSocketOpen() { this.sockets++; }
	noteSocketClose() { this.sockets = Math.max(0, this.sockets - 1); }
	quiesce() { this.paused = true; this.pausedAt = Date.now(); }
	unquiesce() { if (!this.closed) { this.paused = false; this.pausedAt = 0; } }
	isQuiesced() { return this.paused; }
	quiesceInfo() { return { quiesced: this.paused, ...(this.paused ? { quiescedSince: this.pausedAt } : {}) }; }
	activeConversations() { return [...this.clients.values()].reduce((sum, client) => sum + client.activeConversations(), 0); }
	pendingMessages() { return [...this.clients.values()].reduce((sum, client) => sum + client.pendingMessages(), 0); }
	serviceStatus() { return { pid: process.pid, version: OMP_VERSION, cwd: this.cwd, ...this.quiesceInfo(), connectedClients: this.sockets, clientSessions: this.clients.size, activeConversations: this.activeConversations(), pendingMessages: this.pendingMessages(), activePackageOperations: this.packages.activeCount() }; }
	async claimSession(requester: string, sessionId: string) {
		for (const [id, client] of this.clients) {
			if (id === requester || !client.ownsSession(sessionId)) continue;
			const retiring = this.retiring.get(id);
			if (retiring) { await retiring; continue; }
			if (!client.canEvict) throw Error("Conversation is open in another window");
			await this.retire(id, client);
		}
	}
	async disposeAll() {
		this.closed = true; this.quiesce(); clearInterval(this.evictionTimer);
		await this.packages.close(); await Promise.allSettled(this.pending.values()); await Promise.allSettled(this.retiring.values());
		await Promise.all([...this.clients.values()].map(client => client.dispose())); this.clients.clear(); this.idleSince.clear(); this.retiring.clear();
	}
}
