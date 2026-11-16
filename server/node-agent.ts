/** Local OMP process restricted to one captured SSH connection. */
import { NodeCommandApprovals } from "./node-command-policy.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { Type } from "typebox";
import { OmpSession } from "./omp/session.js";
import { OmpPersistenceJournal } from "./omp/persistence-journal.js";
import type { HostTool } from "./omp/host-tools.js";
import type { OmpEnvelope } from "./omp/transport.js";
import { writeFileAtomic } from "./private-file.js";
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
	private session?: OmpSession;
	private creating?: Promise<void>;
	private closing?: Promise<void>;
	private closingWork = false;




	private timer?: ReturnType<typeof setTimeout>;
	private generation = 0;
	private changing = false;
	private savedFile?: string;

	private readonly lifetime = new AbortController();
	constructor(private readonly sessionDir: string, cwd: string, private readonly operations: NodeAgentOperations, private readonly changed: (state: NodeAgentState) => void, private readonly dataDir?: string) {
		this.state = { id: this.id, cwd, phase: "starting", running: false, messages: [], tools: [], models: [], dialogs: [] };
	}
	get busy(): boolean { return this.closingWork || this.state.phase !== "closed" && (this.state.phase === "starting" || this.state.running || this.changing || !!this.session?.busy); }
	snapshot(): NodeAgentState { return { ...this.state, recovery: this.session?.recoverySnapshot() }; }
	terminalCommand(command: NonNullable<NodeAgentState["terminalCommands"]>[number]) {
		this.set({ terminalCommands: [...(this.state.terminalCommands ?? []).filter(item => item.commandId !== command.commandId), command].slice(-200) }, true);
	}
	private set(patch: Partial<NodeAgentState>, immediate = false) {
		this.state = { ...this.state, ...patch };
		if (this.timer) { if (!immediate) return; clearTimeout(this.timer); this.timer = undefined; }
		if (immediate) this.changed(this.snapshot());
		else this.timer = setTimeout(() => { this.timer = undefined; this.changed(this.snapshot()); }, 60);
	}
	private tools(): HostTool[] {
		const signalFor = (signal?: AbortSignal) => signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
		const commandParams = Type.Object({ command: Type.String({ minLength: 1, maxLength: 100000 }), timeout: Type.Optional(Type.Number({ minimum: 1, maximum: 600, description: "Timeout in seconds (default 120)" })) });
		const readParams = Type.Object({ path: Type.String() });
		const writeParams = Type.Object({ path: Type.String(), text: Type.String() });
		const command: HostTool = {
			name: "remote_command",
			description: `Execute a shell command on this SSH node. Each command starts in ${JSON.stringify(this.state.cwd)}; use cd explicitly within a command to change directories. Commands run visibly in the shared interactive terminal; manual input is locked until completion. Read-only Linux queries run without confirmation. Deletions, writes, state changes and unclassified commands require confirmation for each operation. Output is limited to 64 KiB.`,
			parameters: { ...commandParams },
			execute: async (p, { signal, toolCallId }) => {
				if (typeof p.command !== "string" || !p.command.trim() || p.command.length > 100000 || (p.timeout !== undefined && (typeof p.timeout !== "number" || !Number.isFinite(p.timeout) || p.timeout < 1 || p.timeout > 600))) throw Error("Invalid remote command");
				const cancel = signalFor(signal);
				await this.approvals.request(p.command, cancel);
				const result = await this.operations.command(p.command, typeof p.timeout === "number" ? p.timeout : 120, cancel, toolCallId);
				return { content: [{ type: "text", text: result.output }], details: { terminalId: result.terminalId, commandId: result.commandId, lines: result.lines, durationMs: result.durationMs } };
			},
		};
		const read: HostTool = {
			name: "remote_read", description: "Read a UTF-8 file on this SSH node via SFTP (up to 512 KiB). Path must be absolute.", parameters: { ...readParams },
			execute: async (p, { signal }) => { if (typeof p.path !== "string" || !p.path.startsWith("/") || p.path.includes("\0")) throw Error("Invalid remote path"); return { content: [{ type: "text", text: await this.operations.read(p.path, signalFor(signal)) }] }; },
		};
		const write: HostTool = {
			name: "remote_write", description: "Write a UTF-8 file on this SSH node via SFTP (up to 512 KiB). Path must be absolute. Existing content is replaced.", parameters: { ...writeParams },
			execute: async (p, { signal }) => { if (typeof p.path !== "string" || !p.path.startsWith("/") || p.path.includes("\0") || typeof p.text !== "string" || Buffer.byteLength(p.text) > 512 * 1024) throw Error("Invalid remote file"); await this.approvals.request(`Write ${p.path}\n${p.text}`, signalFor(signal), true); await this.operations.write(p.path, p.text, signalFor(signal)); return { content: [{ type: "text", text: "文件已写入节点" }], details: undefined }; },
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
	private get marker() { return join(this.sessionDir, "omp-session.json"); }
	private async createSession(fresh: boolean | string) {
		const generation = ++this.generation;
		mkdirSync(this.sessionDir, { recursive: true, mode: 0o700 });
		let sessionFile: string | undefined;
		if (!fresh) {
			try {
				const saved = JSON.parse(readFileSync(this.marker, "utf8"));
				if (typeof saved.file === "string" && (existsSync(saved.file) || new OmpPersistenceJournal(join(this.dataDir ?? dirname(this.sessionDir), "omp")).read(saved.file).tokens.length > 0)) sessionFile = saved.file;
			}
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		}
		const previous = this.session;
		const selected = previous?.state.model;
		await previous?.close();
		const tools = this.tools();
		const session = new OmpSession({ conversationId: this.id, dataDir: this.dataDir ?? dirname(this.sessionDir), cwd: this.sessionDir, kind: "ssh", sessionFile,
			model: selected ? `${selected.provider}/${selected.id}` : undefined,
			restricted: { toolNames: tools.map(tool => tool.name), systemPrompt: `You are the assistant for one connected SSH node. All provided tools operate only on that node. Remote working directory: ${JSON.stringify(this.state.cwd)}. Use remote_command, remote_read and remote_write for node tasks. Commands run with the SSH user's permissions. You have no local filesystem or local shell tools. Run read-only Linux queries directly using the provided tools. Every deletion, write or state-changing operation requires the tool approval dialog; never treat a previous approval as authorization for another operation. Prefer simple read-only commands over shell scripts for diagnostics. Never assume a previous command's cd persists.` }, tools,
			onChange: () => { if (this.session === session && generation === this.generation) this.refresh(); },
			onEvent: event => { if (this.session === session && generation === this.generation) this.event(event); },
		});
		this.session = session;
		try { if (!session.state.persistence?.failed) await session.open(); }
		catch (error) { await session.close(); throw error; }
		if (this.lifetime.signal.aborted || generation !== this.generation) { await session.close(); throw Error("节点 Agent 已关闭"); }
		writeFileAtomic(this.marker, JSON.stringify({ file: session.state.sessionFile }));
		this.refresh(); this.set({ phase: "ready", running: false, error: session.state.error, tools: [], streamingMessage: undefined }, true);
	}
	async start() {
		try { await this.create(false); }
		catch (error) { if (this.state.phase !== "closed") { this.set({ error: (error as Error).message }); await this.close(); } throw error; }
	}
	close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closingWork = true;
		this.generation++; this.lifetime.abort(); this.approvals.reset();
		const session = this.session; this.session = undefined;
		this.set({ phase: "closed", running: false, streamingMessage: undefined, dialogs: [], tools: this.state.tools.map(tool => ({ ...tool, running: false })) }, true);
		this.closing = (async () => { await Promise.allSettled([this.creating, session?.close()]); })().finally(() => { this.closingWork = false; });
		return this.closing;
	}
	private ready(): OmpSession {
		if (this.state.phase !== "ready" || !this.session || this.changing) throw Error("节点 Agent 尚未就绪");
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
		const native = this.session?.state;
		if (!native) return;
		if (native.sessionFile && native.sessionFile !== this.savedFile) { writeFileAtomic(this.marker, JSON.stringify({ file: native.sessionFile })); this.savedFile = native.sessionFile; }
		const summary = (model: { id: string; provider: string; name: string }) => ({ id: model.id, provider: model.provider, name: model.name });
		this.set({ stats: native.stats, messages: this.retain(native.messages), model: native.model ? summary(native.model) : undefined,
			models: native.models.map(summary), running: native.running, streamingMessage: native.streaming, error: native.error, sessionPersistence: native.persistence });
	}
	async prompt(text: string, queue?: "steer" | "followUp") {
		const session = this.ready();
		if (session.state.sessionFile) writeFileAtomic(this.marker, JSON.stringify({ file: session.state.sessionFile }));
		if (!text.trim() || text.length > 200000) throw Error("消息无效");
		if (!session.state.model) throw Error("请先在本机设置中配置 OMP 模型，再重新打开节点 Agent");
		if (this.state.running) {
			if (!queue) throw Error("节点 Agent 正在处理请求，请稍后或排队发送");
			await session.command(queue === "followUp" ? "follow_up" : "steer", { message: text }); return;
		}
		this.set({ tools: [], error: undefined }, true);
		await session.prompt(text);
	}
	async abort() {
		const session = this.ready(); this.approvals.reset();
		await session.stop();
		if (this.session === session && this.state.phase === "ready") this.set({ running: false, tools: this.state.tools.map(tool => ({ ...tool, running: false })) }, true);
	}
	async cancelRecovery(operationId: string) { await this.ready().cancelRecovery(operationId); }
	async reopen() {
		const session = this.ready();
		// ready() guards initialization and changes. Native recovery may still
		// be cleaning up; reopen itself waits for that work before reading.
		if (this.state.running) throw Error("请先停止当前任务");
		this.changing = true;
		try {
			await session.reopen(() => { if (this.session !== session || this.lifetime.signal.aborted) throw Error("节点 Agent 会话已关闭"); });
			this.refresh();
		} finally { this.changing = false; }
	}
	async newSession() {
		this.ready(); if (this.state.running) throw new Error("请先停止当前任务");
		this.changing = true;
		try { this.approvals.reset(); this.set({ terminalCommands: [] }); await this.create(true); } finally { this.changing = false; }
	}
	async model(provider: string, modelId: string) {
		const session = this.ready(); if (this.state.running) throw Error("请先停止当前任务");
		this.changing = true;
		try { await session.setModel(provider, modelId); this.refresh(); } finally { this.changing = false; }
	}
	dialog(id: string, response: { cancelled?: boolean; value?: string; confirmed?: boolean; remember?: boolean }) { this.approvals.respond(id, response.confirmed === true && !response.cancelled, response.remember); }
	private event(envelope: OmpEnvelope) {
		const event = envelope.frame;
		if ((event.type === "tool_execution_start" || event.type === "tool_execution_end") && typeof event.toolCallId === "string" && typeof event.toolName === "string") this.set({ tools: [...this.state.tools.filter(tool => tool.id !== event.toolCallId), { id: event.toolCallId, name: event.toolName, running: event.type === "tool_execution_start", isError: event.type === "tool_execution_end" && event.isError === true }].slice(-256) });
		if (event.type === "session_settled") { this.refresh(); this.set({ running: false, streamingMessage: undefined }, true); }
	}
}
