import { expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModelDiagnostics, diagnosticEvent } from "../../server/model-diagnostics.js";

it("records only event metadata, never arbitrary error text", () => {
	const event = { type: "agent_settled" as const, aborted: false };
	expect(diagnosticEvent({ ...event, secret: "credential" } as typeof event)).toEqual({ type: "agent_settled" });
	const dir = mkdtempSync(join(tmpdir(), "model-diagnostics-"));
	try {
		createModelDiagnostics(dir)(event);
		const files = readdirSync(dir);
		expect(files).toHaveLength(1);
		expect(JSON.parse(readFileSync(join(dir, files[0]), "utf8"))).toMatchObject({ type: "agent_settled" });
		createModelDiagnostics(join(dir, files[0], "invalid"))(event);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

it("projects malformed native frames without leaking strings in metadata fields", () => {
	const secret = "SECRET_CREDENTIAL_OR_PROJECT_CONTENT";
	const result = diagnosticEvent({ type: "message_end", message: { role: "assistant", stopReason: secret, errorMessage: secret, content: [{ type: secret, text: secret }, { type: "thinking", thinking: secret, signature: secret }], usage: { input: secret, output: 42, cacheRead: Infinity, cacheWrite: -1 } } });
	expect(result).toEqual({ type: "message_end", stopReason: "other", usage: { output: 42 }, blockCount: 2, blocks: [{ type: "other" }, { type: "thinking" }] });
	expect(JSON.stringify(result)).not.toContain(secret);
	expect(diagnosticEvent({ type: secret })).toEqual({ type: "other" });
	expect(diagnosticEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: secret, contentIndex: 2, partial: secret } })).toEqual({ type: "message_update", streamType: "thinking_delta", characters: secret.length, contentIndex: 2 });
	expect(diagnosticEvent({ type: "message_update", assistantMessageEvent: null })).toEqual({ type: "message_update", streamType: "other" });
});

it("caps a whole trace, including a large final event, with owner-only files", () => {
	const dir = mkdtempSync(join(tmpdir(), "model-diagnostics-cap-"));
	try {
		const write = createModelDiagnostics(dir);
		const event = { type: "message_end", message: { role: "assistant", content: Array.from({ length: 300 }, () => ({ type: "thinking", thinking: "DO_NOT_RECORD" })), usage: { output: 1 }, stopReason: "stop" } };
		for (let i = 0; i < 2000; i++) write(event);
		const file = join(dir, readdirSync(dir)[0]), size = statSync(file).size;
		expect(size).toBeGreaterThan(8 * 1024 * 1024 - 10000);
		expect(size).toBeLessThanOrEqual(8 * 1024 * 1024);
		write(event); expect(statSync(file).size).toBe(size);
		if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, "utf8")).not.toContain("DO_NOT_RECORD");
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
