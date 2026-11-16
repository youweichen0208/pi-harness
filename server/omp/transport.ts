import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { killPidTree } from "../process-utils.js";
import { OMP_FRAME_BYTES, OmpFrameDecoder } from "./framing.js";

export type OmpFrame = { type: string; id?: string; [key: string]: unknown };
export type OmpEnvelope = { conversationId: string; generation: string; sequence: number; frame: OmpFrame };
export interface OmpTransportOptions {
	conversationId: string;
	executable: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	onEvent: (event: OmpEnvelope) => void;
	onExit: (error: Error) => void;
	requestTimeoutMs?: number;
}

/** Node-owned transport only. No SDK types, credentials or transcript enter browser code here. */
export class OmpTransport {
	readonly generation: string = randomUUID();
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly pending = new Map<string, { command: string; resolve: (frame: OmpFrame) => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
	private promptResults = new Map<string, (frame: OmpFrame) => void>();
	private decoder = new TextDecoder("utf-8", { fatal: true });
	private frames = new OmpFrameDecoder();
	private buffer = "";
	private sequence = 0;
	private ended = false;
	private closing = false;
	private closePromise?: Promise<void>;
	private exited: Promise<void>;
	private busy = false;
	get hasPendingRequests() { return this.pending.size > 0; }

	constructor(private readonly options: OmpTransportOptions) {
		this.child = spawn(options.executable, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
		this.exited = new Promise(resolve => this.child.once("close", () => resolve()));
		// Never forward raw stderr: providers/extensions can include secrets in diagnostics.
		this.child.stderr.on("data", () => {});
		this.child.stdout.on("data", (chunk: Buffer) => this.read(chunk));
		this.child.stdin.on("error", () => this.fail(new Error("OMP input channel closed")));
		this.child.on("error", () => this.fail(new Error("OMP process could not start")));
		this.child.on("close", (code, signal) => this.fail(new Error(`OMP process exited (${signal ?? code ?? "unknown"})`)));
	}

	/** Busy includes queued/background work; agent_end alone cannot clear it. */
	get isBusy(): boolean { return this.busy; }

	request(command: string, payload: Record<string, unknown> = {}, onPromptResult?: (frame: OmpFrame) => void): Promise<OmpFrame> {
		if (this.ended || this.closing) return Promise.reject(new Error("OMP transport is closed"));
		if (this.pending.size >= 256 || onPromptResult && this.promptResults.size >= 256) return Promise.reject(new Error("Too many pending OMP requests"));
		const id = randomUUID();
		let line: string;
		try { line = JSON.stringify({ ...payload, type: command, id }) + "\n"; }
		catch { return Promise.reject(new Error("OMP request is not serializable")); }
		if (Buffer.byteLength(line) + this.child.stdin.writableLength > 8 * 1024 * 1024) return Promise.reject(new Error("OMP request exceeds transport limit"));
		return new Promise((resolve, reject) => {
			// These native commands reply on completion, not admission. A summary
			// can legitimately outlast the acknowledgement deadline; cancel/Stop
			// or process exit still rejects/settles the outstanding request.
			const completion = command === "compact" || command === "navigate_tree";
			const timer = completion ? undefined : setTimeout(() => {
				this.pending.delete(id); this.promptResults.delete(id);
				// Timeout is an unknown outcome, never permission to resend a prompt.
				reject(new Error(`OMP ${command} acknowledgement timed out; execution outcome is unknown`));
			}, this.options.requestTimeoutMs ?? (command === "login" ? 600_000 : 30_000));
			this.pending.set(id, { command, resolve, reject, timer });
			if (command === "prompt" && onPromptResult) this.promptResults.set(id, onPromptResult);
			this.child.stdin.write(line, error => {
				if (error) this.fail(new Error("OMP request could not be delivered"));
			});
		});
	}

	private read(chunk: Buffer): void {
		if (this.ended) return;
		try { this.buffer += this.decoder.decode(chunk, { stream: true }); }
		catch { this.protocolFailure(); return; }
		let index: number;
		while ((index = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, index);
			this.buffer = this.buffer.slice(index + 1);
			if (!line.trim()) continue;
			if (Buffer.byteLength(line) + 1 > OMP_FRAME_BYTES) { this.protocolFailure(); return; }
			let value: unknown;
			try { value = this.frames.push(JSON.parse(line)); } catch { this.protocolFailure(); return; }
			if (value === undefined) continue;
			if (!value || typeof value !== "object" || Array.isArray(value) || typeof (value as OmpFrame).type !== "string") { this.protocolFailure(); return; }
			const frame = value as OmpFrame;
			if (frame.type === "response" && typeof frame.id === "string") {
				const waiter = this.pending.get(frame.id);
				if (waiter) {
					clearTimeout(waiter.timer); this.pending.delete(frame.id);
					if (frame.success === false || frame.data && typeof frame.data === "object" && "agentInvoked" in frame.data && frame.data.agentInvoked === false) this.promptResults.delete(frame.id);
					if (frame.success === false) waiter.reject(new Error(`OMP ${waiter.command} command rejected`));
					else waiter.resolve(frame);
				}
				continue;
			}
			if (frame.type === "agent_start") this.busy = true;
			if (frame.type === "prompt_result") this.busy = frame.sessionSettled !== true;
			if (frame.type === "session_settled") this.busy = false;
			try {
				if (frame.type === "prompt_result" && typeof frame.id === "string") {
					const result = this.promptResults.get(frame.id); this.promptResults.delete(frame.id); result?.(frame);
				}
				this.options.onEvent({ conversationId: this.options.conversationId, generation: this.generation, sequence: ++this.sequence, frame }); }
			catch { this.fail(Error("OMP event consumer failed")); this.kill(); return; }
			if (this.ended) return;
		}
		if (Buffer.byteLength(this.buffer) >= OMP_FRAME_BYTES) this.protocolFailure();
	}

	private kill(): void {
		if (this.child.pid) killPidTree(this.child.pid);
		this.child.kill("SIGKILL");
	}

	/** Replies to native tool/UI requests are one-way and retain the upstream request ID. */
	send(frame: OmpFrame): void {
		if (this.ended || this.closing) throw Error("OMP transport is closed");
		const line = JSON.stringify(frame) + "\n";
		if (Buffer.byteLength(line) + this.child.stdin.writableLength > 8 * 1024 * 1024) throw Error("OMP request exceeds transport limit");
		this.child.stdin.write(line, error => { if (error) this.fail(Error("OMP response could not be delivered")); });
	}

	private protocolFailure(): void {
		this.fail(new Error("OMP emitted an invalid or oversized protocol frame"));
		this.kill();
	}

	private fail(error: Error): void {
		if (this.ended) return;
		this.ended = true;
		this.buffer = "";
		this.frames.clear();
		this.busy = false;
		for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
		this.pending.clear(); this.promptResults.clear();
		if (!this.closing) this.options.onExit(error);
	}

	/** Transport shutdown only; the runtime must abort/dispose owned jobs first. */
	close(): Promise<void> {
		return this.closePromise ??= this.closeOnce();
	}

	private async closeOnce(): Promise<void> {
		this.closing = true;
		this.fail(new Error("OMP transport closed by host"));
		this.child.stdin.end();
		const terminate = setTimeout(() => this.child.kill("SIGTERM"), 5000);
		const kill = setTimeout(() => this.kill(), 10_000);
		try { await this.exited; }
		finally { clearTimeout(terminate); clearTimeout(kill); }
	}
}
