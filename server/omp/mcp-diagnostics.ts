/** Bun-only, per-worker projection of public OMP connection events. */
import type { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { McpConnectionStatusEvent } from "@oh-my-pi/pi-coding-agent/mcp/startup-events";
import { normalizeMCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import type { UiOmpMcpConnectionEvent, UiOmpMcpFailure } from "../protocol.js";

const EVENT_LIMIT = 100, SERVER_LIMIT = 1000;
export class OmpMcpDiagnostics {
	private events: UiOmpMcpConnectionEvent[] = [];
	private failures = new Map<string, UiOmpMcpFailure>();
	private duringStartup?: Set<string> = new Set();
	private sequence = 0;
	private dropped = 0;
	private disposed = false;
	private unsubscribe?: () => void;
	constructor(private manager?: MCPManager) {
		this.unsubscribe = manager?.addConnectionStatusListener(event => this.observe(event));
	}
	private transport(name: string): UiOmpMcpFailure["transport"] {
		const config = this.manager?.getServerConfig(name);
		return !config ? "unknown" : "command" in config ? "stdio" : "url" in config ? "http" : "unknown";
	}
	private append(name: string, type: UiOmpMcpConnectionEvent["type"], error: string | undefined, origin: UiOmpMcpConnectionEvent["origin"]) {
		if (this.disposed) return;
		const transport = this.transport(name);
		let failure: UiOmpMcpFailure | undefined;
		if (type === "failed") {
			// Native callbacks stringify errors. Classification can be unknown when
			// structured fields were lost. Never forward message/data/traceId: a
			// remote server may echo arbitrary credentials without recognizable keys.
			const normalized = normalizeMCPTransportError(new Error(error ?? ""), { transport, stage: "connect" });
			failure = { transport, failure: normalized.failure };
			if (normalized.failure === "http_status" && typeof normalized.code === "number" && normalized.code >= 100 && normalized.code <= 599) failure.httpStatus = normalized.code;
			this.failures.delete(name);
			this.failures.set(name, failure);
			if (this.failures.size > SERVER_LIMIT) this.failures.delete(this.failures.keys().next().value!);
		} else this.failures.delete(name);
		this.events.push({ sequence: ++this.sequence, observedAt: Date.now(), name: name.slice(0, 256), type, origin, transport, ...failure });
		if (this.events.length > EVENT_LIMIT) { this.events.shift(); this.dropped++; }
	}
	private observe(event: McpConnectionStatusEvent) {
		const names = event.type === "connecting" ? event.serverNames : [event.serverName];
		for (const name of names.slice(0, SERVER_LIMIT)) {
			// Only needed during the one-time seed; avoid replacing a newer event
			// with a startup snapshot when the startup barrier settles concurrently.
			if (this.duringStartup && this.duringStartup.size < SERVER_LIMIT) this.duringStartup.add(name);
			this.append(name, event.type, event.type === "failed" ? event.error : undefined, "event");
		}
	}
	async initialize() {
		if (!this.duringStartup) return;
		try {
			// Zero means infinite in OMP. A positive budget observes pending startup
			// without turning a settings read into a connection readiness barrier.
			const status = await this.manager?.waitForStartup(1);
			if (!status) return;
			const seed = (name: string, type: UiOmpMcpConnectionEvent["type"], error?: string) => {
				if (!this.duringStartup?.has(name)) this.append(name, type, error, "snapshot");
			};
			for (const name of status.connected.slice(0, SERVER_LIMIT)) seed(name, "connected");
			for (const name of status.pending.slice(0, SERVER_LIMIT)) seed(name, "connecting");
			for (const item of status.failed.slice(0, SERVER_LIMIT)) seed(item.name, "failed", item.error);
		} finally { this.duringStartup = undefined; }
	}
	get snapshot() { return { events: this.events.map(event => ({ ...event })), dropped: this.dropped }; }
	failure(name: string) {
		return this.manager?.getConnectionStatus(name) === "disconnected" ? this.failures.get(name) : undefined;
	}
	dispose() { this.disposed = true; this.unsubscribe?.(); this.unsubscribe = undefined; this.duringStartup = undefined; }
}
