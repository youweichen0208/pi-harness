import { it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpProviderAuth } from "../../server/omp/provider-auth.js";
import type { OmpEnvelope, OmpFrame } from "../../server/omp/transport.js";
import type { ServerMessage } from "../../server/protocol.js";

it("binds login input, rejects stale replies, and never echoes callback secrets", async () => {
	const root = mkdtempSync(join(tmpdir(), "omp-auth-"));
	const events: ServerMessage[] = [], replies: OmpFrame[] = [];
	let observe!: (e: OmpEnvelope) => void, finish!: (frame: OmpFrame) => void;
	const auth = new OmpProviderAuth(root, e => events.push(e), callback => {
		observe = callback;
		return { open: async () => {}, close: async () => {}, reply: frame => replies.push(frame), command: async command => command === "get_login_providers" ? { type: "response", data: { providers: [{ id: "fixture", available: true }] } } : new Promise(resolve => { finish = resolve; }) };
	});
	try {
		const task = auth.login("fixture");
		await new Promise(resolve => setTimeout(resolve, 0));
		const event = (frame: OmpFrame) => observe({ conversationId: "auth", generation: "g", sequence: 1, frame });
		event({ type: "extension_ui_request", method: "open_url", url: "javascript:alert(1)" });
		event({ type: "extension_ui_request", method: "open_url", url: "https://example.test/login" });
		event({ type: "extension_ui_request", method: "input", id: "input-1", title: "Callback" });
		const current = events.at(-1); if (current?.type !== "provider_auth") throw Error("Missing auth state");
		expect(current.state.url).toBe("https://example.test/login");
		expect(() => auth.respond("wrong", "input-1", "secret")).toThrow();
		auth.respond(current.state.requestId, "input-1", "CALLBACK_SECRET");
		expect(() => auth.respond(current.state.requestId, "input-1", "again")).toThrow();
		expect(replies).toEqual([{ type: "extension_ui_response", id: "input-1", value: "CALLBACK_SECRET" }]);
		finish({ type: "response", success: true }); await task;
		expect(JSON.stringify(events)).not.toContain("CALLBACK_SECRET");
		expect(events.at(-1)).toMatchObject({ type: "provider_auth", state: { phase: "success" } });
	} finally { await auth.close(); rmSync(root, { recursive: true, force: true }); }
});

it("cancel closes only the auth worker and ignores late auth events", async () => {
	const root = mkdtempSync(join(tmpdir(), "omp-auth-")), events: ServerMessage[] = [];
	let observe!: (e: OmpEnvelope) => void, rejectLogin!: (error: Error) => void, closes = 0;
	const auth = new OmpProviderAuth(root, e => events.push(e), callback => {
		observe = callback;
		return { open: async () => {}, close: async () => { closes++; rejectLogin?.(Error("closed")); }, reply() {}, command: async command => command === "get_login_providers" ? { type: "response", data: { providers: [{ id: "fixture", available: true }] } } : new Promise((_resolve, reject) => { rejectLogin = reject; }) };
	});
	try {
		const task = auth.login("fixture"); await new Promise(resolve => setTimeout(resolve, 0));
		const first = events[0]; if (first.type !== "provider_auth") throw Error("Missing auth state");
		await auth.cancel(first.state.requestId); await task;
		const length = events.length;
		observe({ conversationId: "auth", generation: "g", sequence: 1, frame: { type: "extension_ui_request", method: "open_url", url: "https://example.test/late" } });
		expect(events).toHaveLength(length); expect(closes).toBeGreaterThan(0);
		expect(events.at(-1)).toMatchObject({ type: "provider_auth", state: { phase: "cancelled" } });
	} finally { await auth.close(); rmSync(root, { recursive: true, force: true }); }
});
