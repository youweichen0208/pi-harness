import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequestDiagnostics, requestProjection } from "../../server/omp/request-diagnostics.js";

it("preserves Anthropic tool pairing and request parameters without exposing content or schemas", () => {
	const secret = "UNLABELLED_CREDENTIAL", key = new Uint8Array(32).fill(3);
	const payload = { model: secret, max_tokens: 128000, thinking: { type: "enabled", budget_tokens: 16000 }, output_config: { effort: "high" }, system: secret,
		tools: [{ name: secret, description: secret, input_schema: { type: "object", properties: { [secret]: { type: "string", default: secret } }, required: [secret] } }],
		messages: [{ role: "assistant", content: [{ type: "thinking", thinking: secret, signature: secret }, { type: "tool_use", id: secret, name: secret, input: { path: secret } }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: secret, content: secret }] }] };
	const result = requestProjection(payload, key);
	expect(result.maxTokens).toBe(128000); expect(result.thinking).toEqual({ type: "enabled", budgetTokens: 16000, effort: "high" });
	expect(result.messages[0].blocks[0].signature).toBe(true);
	expect(result.messages[0].blocks[1].call).toBe(result.messages[1].blocks[0].call);
	expect(result.tools[0].schema).toMatchObject({ type: "object", properties: 1, required: 1 });
	expect(JSON.stringify(result)).not.toContain(secret);
	expect(result).toEqual(requestProjection(payload, key));
	expect(result.digest).not.toBe(requestProjection(payload, new Uint8Array(32).fill(4)).digest);
	expect(result.tools[0].schema.digest).not.toBe(requestProjection({ ...payload, tools: [{ ...payload.tools[0], input_schema: { type: "object" } }] }, key).tools[0].schema.digest);
});

it("projects OpenAI completion and Responses call references and bounds history", () => {
	const key = new Uint8Array(32);
	const completion = requestProjection({ max_completion_tokens: 16000, reasoning_effort: "medium", messages: [
		{ role: "assistant", tool_calls: [{ id: "private-call", function: { name: "private-name", arguments: '{"secret":"private"}' } }] },
		{ role: "tool", tool_call_id: "private-call", content: "private-result" },
	] }, key);
	expect(completion.maxCompletionTokens).toBe(16000); expect(completion.thinking.effort).toBe("medium");
	expect(completion.messages[0].calls[0].call).toBe(completion.messages[1].call);
	const responses = requestProjection({ max_output_tokens: 32000, input: [{ type: "function_call", call_id: "private-call" }, { type: "function_call_output", call_id: "private-call", output: "private-result" }] }, key);
	expect(responses.messages[0].item?.call).toBe(responses.messages[1].item?.call);
	expect(JSON.stringify([completion, responses])).not.toContain("private");
	const bounded = requestProjection({ messages: Array.from({ length: 300 }, () => ({ role: "CREDENTIAL", content: Array.from({ length: 300 }, () => ({ type: "CREDENTIAL", text: "CREDENTIAL" })) })) }, key);
	expect(bounded.messages).toHaveLength(256); expect(bounded.messages[0].index).toBe(44); expect(bounded.messagesTruncated).toBe(true);
	expect(bounded.messages[0].blocks).toHaveLength(256); expect(bounded.messages[0].blocksTruncated).toBe(true);
	expect(JSON.stringify(bounded)).not.toContain("CREDENTIAL");
});

it("keeps a local key, isolates trace files, signals the cap and fails closed on invalid storage", () => {
	const dir = mkdtempSync(join(tmpdir(), "request-diagnostics-"));
	try {
		expect(createRequestDiagnostics(undefined)).toBeUndefined();
		const a = createRequestDiagnostics(dir)!, b = createRequestDiagnostics(dir)!;
		expect(a.digest("secret")).toBe(b.digest("secret"));
		const chunk = { type: "metadata", flags: Array.from({ length: 1000 }, () => true) };
		for (let i = 0; i < 1800; i++) a.write(chunk);
		b.write({ type: "other-worker" });
		const files = readdirSync(dir).filter(file => file.endsWith('.jsonl'));
		expect(files).toHaveLength(2);
		const full = files.find(file => statSync(join(dir, file)).size > 1000)!;
		expect(statSync(join(dir, full)).size).toBeLessThanOrEqual(8 * 1024 * 1024);
		expect(readFileSync(join(dir, full), "utf8").trim().split('\n').at(-1)).toContain('"diagnostics_limit"');
		if (process.platform !== "win32") for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
		writeFileSync(join(dir, '.request-diagnostics-key'), 'invalid'); expect(createRequestDiagnostics(dir)).toBeUndefined();
		expect(createRequestDiagnostics(join(dir, full, 'not-a-directory'))).toBeUndefined();
	} finally { rmSync(dir, { recursive: true, force: true }); }
});
