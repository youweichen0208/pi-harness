import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ProviderAuthState, ServerMessage } from "../protocol.js";
import { OmpSession } from "./session.js";
import { isRecord } from "./framing.js";
import type { OmpEnvelope } from "./transport.js";

type AuthSession = Pick<OmpSession, "open" | "command" | "reply" | "close">;
type Factory = (event: (envelope: OmpEnvelope) => void) => AuthSession;
/** Authentication has its own worker; cancelling it cannot stop a chat task. */
export class OmpProviderAuth {
	private pending?: { state: ProviderAuthState; session: AuthSession; cancelled: boolean; done?: Promise<void> };
	private closed = false;
	constructor(private readonly dataDir: string, private readonly emit: (event: ServerMessage) => void, private readonly factory?: Factory) {}
	private publish(state: ProviderAuthState) { if (!this.closed) this.emit({ type: "provider_auth", state: { ...state } }); }
	replay() { if (this.pending) this.publish(this.pending.state); }
	async login(provider: string) {
		if (this.closed || this.pending) throw Error("Authentication already in progress or closed");
		if (!/^[a-zA-Z0-9_-]{1,120}$/.test(provider)) throw Error("Invalid provider");
		const requestId = randomUUID();
		const state: ProviderAuthState = { requestId, provider, phase: "pending" };
		const cwd = join(this.dataDir, "omp", "auth"); mkdirSync(cwd, { recursive: true, mode: 0o700 });
		const observe = (event: OmpEnvelope) => {
			if (this.pending !== job || job.cancelled) return;
			const frame = event.frame;
			if (frame.type !== "extension_ui_request") return;
			if (frame.method === "open_url" && typeof frame.url === "string") {
				let url: URL; try { url = new URL(frame.url); } catch { return; }
				if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) return;
				state.url = url.href; state.message = typeof frame.instructions === "string" ? frame.instructions.slice(0, 16000) : undefined;
			} else if (frame.method === "input" && typeof frame.id === "string") {
				state.prompt = { id: frame.id, kind: "text", message: String(frame.title ?? "").slice(0, 16000), placeholder: typeof frame.placeholder === "string" ? frame.placeholder : undefined };
			} else if (frame.method === "notify") state.message = String(frame.message ?? "").slice(0, 16000);
			else return;
			this.publish(state);
		};
		const session = this.factory ? this.factory(observe) : new OmpSession({ dataDir: this.dataDir, cwd, conversationId: requestId, kind: "auth", restricted: { systemPrompt: "Authentication only. No model requests.", toolNames: [] }, onChange() {}, onEvent: observe });
		const job = { state, session, cancelled: false, done: undefined as Promise<void> | undefined };
		this.pending = job; this.publish(state);
		job.done = (async () => {
			try {
				await session.open();
				if (job.cancelled) return;
				const catalog = await session.command("get_login_providers");
				if (!isRecord(catalog.data) || !Array.isArray(catalog.data.providers) || !catalog.data.providers.some(item => isRecord(item) && item.id === provider && item.available === true)) throw Error("Provider unavailable");
				if (job.cancelled) return;
				await session.command("login", { providerId: provider });
				if (!job.cancelled) { state.phase = "success"; state.prompt = undefined; state.url = undefined; state.message = undefined; this.publish(state); }
			} catch { if (!job.cancelled) { state.phase = "error"; state.prompt = undefined; state.url = undefined; state.message = "OMP authentication failed. Existing credentials were not removed."; this.publish(state); } }
			finally { await session.close(); if (this.pending === job) this.pending = undefined; await OmpSession.refreshCredentials(this.dataDir); }
		})();
		await job.done;
	}
	respond(requestId: string, promptId: string, value: string) {
		const job = this.pending;
		if (!job || job.cancelled || job.state.requestId !== requestId || job.state.prompt?.id !== promptId || typeof value !== "string" || value.length > 16384) throw Error("Authentication prompt expired");
		job.session.reply({ type: "extension_ui_response", id: promptId, value });
		job.state.prompt = undefined; this.publish(job.state);
	}
	async cancel(requestId: string) {
		const job = this.pending; if (!job || job.state.requestId !== requestId) return;
		job.cancelled = true; job.state = { requestId, provider: job.state.provider, phase: "cancelled" }; this.publish(job.state);
		await job.session.close(); await job.done;
	}
	async close() { this.closed = true; if (this.pending) await this.cancel(this.pending.state.requestId); }
}
