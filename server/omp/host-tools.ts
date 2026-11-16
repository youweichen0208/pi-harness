import { isRecord } from "./framing.js";
import type { OmpEnvelope, OmpFrame, OmpTransport } from "./transport.js";

export interface HostToolResult {
	content: { type: "text"; text: string }[];
	details?: unknown;
}
export interface HostTool {
	name: string;
	description: string;
	parameters: Record<string, unknown>;
	/** The business handler must validate authorization and arguments on every invocation. */
	execute(args: Record<string, unknown>, context: { signal: AbortSignal; toolCallId: string; conversationId: string }): Promise<HostToolResult>;
}

/** One conversation's explicit capabilities. No file/SSH/database access lives in this bridge. */
export class OmpHostTools {
	private runtime?: Pick<OmpTransport, "generation" | "request" | "send">;
	private readonly tools: Map<string, HostTool>;
	private readonly active = new Map<string, AbortController>();
	private readonly seen = new Set<string>();
	private closed = false;

	constructor(private readonly conversationId: string, tools: HostTool[]) {
		this.tools = new Map(tools.map(tool => [tool.name, tool]));
		if (this.tools.size !== tools.length) throw Error("Duplicate OMP host tool name");
	}

	async bind(runtime: Pick<OmpTransport, "generation" | "request" | "send">): Promise<void> {
		if (this.closed || this.runtime) throw Error("OMP host tools already bound or closed");
		this.runtime = runtime;
		await runtime.request("set_host_tools", { tools: [...this.tools.values()].map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, loadMode: "essential" })) });
	}

	/** Returns true only for the native host-tool side channel. */
	observe(event: OmpEnvelope): boolean {
		const frame = event.frame;
		if (frame.type !== "host_tool_call" && frame.type !== "host_tool_cancel") return false;
		if (this.closed || !this.runtime || event.conversationId !== this.conversationId || event.generation !== this.runtime.generation) return true;
		if (frame.type === "host_tool_cancel") {
			if (typeof frame.targetId === "string") this.active.get(frame.targetId)?.abort();
			return true;
		}
		if (typeof frame.id !== "string" || this.seen.has(frame.id)) return true;
		// Fail closed rather than evicting IDs and accidentally re-executing an old call.
		if (this.seen.size >= 65536) { this.reply(frame.id, { content: [{ type: "text", text: "Host tool request limit reached; start a new session." }] }, true); return true; }
		this.seen.add(frame.id);
		const tool = typeof frame.toolName === "string" ? this.tools.get(frame.toolName) : undefined;
		if (!tool || !isRecord(frame.arguments) || typeof frame.toolCallId !== "string") {
			this.reply(frame.id, { content: [{ type: "text", text: "Host tool is unavailable or its arguments are invalid." }] }, true);
			return true;
		}
		const controller = new AbortController();
		this.active.set(frame.id, controller);
		const id = frame.id;
		void Promise.resolve().then(() => {
			controller.signal.throwIfAborted();
			return tool.execute(frame.arguments as Record<string, unknown>, { signal: controller.signal, toolCallId: frame.toolCallId as string, conversationId: this.conversationId });
		}).then(result => {
			if (!controller.signal.aborted) {
				const serialized = JSON.stringify(result);
				if (Buffer.byteLength(serialized) > 1024 * 1024) throw Error("Host tool result too large");
				this.reply(id, result);
			}
		}).catch(() => {
			// The business tool can return a user-safe error result; raw exceptions may include secrets.
			if (!controller.signal.aborted) this.reply(id, { content: [{ type: "text", text: "Host tool failed. Check the operation in the workbench." }] }, true);
		}).finally(() => this.active.delete(id));
		return true;
	}

	private reply(id: string, result: HostToolResult, isError = false): void {
		if (this.closed) return;
		const frame: OmpFrame = { type: "host_tool_result", id, result, isError };
		try { this.runtime?.send(frame); } catch { this.close(); }
	}

	close(): void {
		this.closed = true;
		for (const controller of this.active.values()) controller.abort();
		this.active.clear();
		this.seen.clear();
	}
}
