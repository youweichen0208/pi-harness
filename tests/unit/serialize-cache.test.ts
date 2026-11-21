import { expect, test } from "vitest";
import { createHash } from "node:crypto";
import { contentFingerprint, type AgentMessage } from "../../server/serialize.js";

test("same-millisecond custom messages retain distinct cache identities", () => {
	const message: AgentMessage = { role: "custom", customType: "tool-call-recovery", content: "Correction deferred", display: true, details: { status: "deferred" }, timestamp: 1234 };
	const extension: AgentMessage = { ...message, customType: "extension-queue", content: "Wait for confirmation" };
	expect(contentFingerprint(message)).not.toBe(contentFingerprint(extension));
	expect(contentFingerprint(message)).not.toBe(contentFingerprint({ ...message, content: "Correction stopped" }));
	expect(contentFingerprint(message)).not.toBe(contentFingerprint({ ...message, details: { status: "cancelled" } }));
	expect(contentFingerprint(message)).not.toBe(contentFingerprint({ ...message, display: false }));
	expect(contentFingerprint(message)).toBe(contentFingerprint({ ...message }));
});

test("fingerprints include tails and every content block, including image bytes", () => {
	const make = (suffix: string): AgentMessage => ({ role: "user", timestamp: 42, content: [{ type: "text", text: "x".repeat(520) + suffix }] });
	expect(contentFingerprint(make("a"))).not.toBe(contentFingerprint(make("b")));
	const image = (data: string): AgentMessage => ({ role: "user", timestamp: 42, content: [{ type: "image", mimeType: "image/png", data }] });
	expect(contentFingerprint(image("AAAA"))).not.toBe(contentFingerprint(image("BBBB")));
	const second = (text: string): AgentMessage => ({ role: "user", timestamp: 42, content: [{ type: "text", text: "same" }, { type: "text", text }] });
	expect(contentFingerprint(second("one"))).not.toBe(contentFingerprint(second("two")));
});

/**
 * Mirror of AgentService.serializeCached()'s key + cache contract, which is
 * what currentMessages() now feeds a precomputed key into. Kept as a pure
 * function so the cache invariants are testable without a live session.
 * MUST be updated together with serializeCached().
 */
function serializeCachedMirror(input: {
	message: Extract<AgentMessage, { role: "toolResult" }>;
	contentKey: string;
	nextId: () => number;
	contentIds: WeakMap<readonly unknown[], number>;
	contentSeq: () => number;
	cache: Map<string, object>;
	toolName?: string;
}) {
	const { message, contentKey } = input;
	const n = input.nextId();
	let contentId = input.contentIds.get(message.content);
	if (contentId === undefined) {
		contentId = input.contentSeq();
		input.contentIds.set(message.content, contentId);
	}
	const metadata = JSON.stringify({ ...message, content: [] });
	const cacheKey = `${contentKey}#${n}:${contentId}:${createHash("sha256").update(metadata).digest("hex")}`;
	return { cacheKey, cached: input.cache.get(cacheKey) };
}

const big = "x".repeat(1_600_000);
function toolResult(overrides: Partial<Extract<AgentMessage, { role: "toolResult" }>> = {}): Extract<AgentMessage, { role: "toolResult" }> {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "bash",
		content: [{ type: "text", text: big }],
		isError: false,
		timestamp: 7,
		nestedCalls: { complete: true, calls: [{ id: "n1", name: "read", status: "ok", durationMs: 1, arguments: { path: "a.ts" } }] },
		...overrides,
	} as Extract<AgentMessage, { role: "toolResult" }>;
}

function harness(message: Extract<AgentMessage, { role: "toolResult" }>) {
	let ids = 0, seq = 0;
	const cache = new Map<string, object>();
	const contentIds = new WeakMap<readonly unknown[], number>();
	const run = (m = message) => {
		const result = serializeCachedMirror({ message: m, contentKey: `t:${m.toolCallId}`, nextId: () => ids++, contentIds, contentSeq: () => ++seq, cache });
		return result;
	};
	const runStable = (m = message) => {
		const result = serializeCachedMirror({ message: m, contentKey: `t:${m.toolCallId}`, nextId: () => 0, contentIds, contentSeq: () => ++seq, cache });
		if (!result.cached) { const value = {}; cache.set(result.cacheKey, value); return { cacheKey: result.cacheKey, cached: value }; }
		return result;
	};
	return { run, runStable };
}

test("a 1.6 MB toolResult keeps one stable cache key across 200 snapshots", () => {
	const { runStable } = harness(toolResult());
	const first = runStable().cacheKey;
	for (let i = 0; i < 200; i++) expect(runStable().cacheKey).toBe(first);
});

test("metadata changes that the hash covers produce a new cache entry", () => {
	const message = toolResult();
	const { runStable } = harness(message);
	const first = runStable();
	const before = first.cacheKey;
	expect(runStable({ ...message, isError: true }).cacheKey).not.toBe(before);
	expect(runStable({ ...message, nestedCalls: { complete: true, calls: [] } }).cacheKey).not.toBe(before);
	expect(runStable({ ...message, durationMs: 12 }).cacheKey).not.toBe(before);
	// A new content array gets a new contentId, so the key changes too.
	expect(runStable({ ...message, content: [{ type: "text", text: "other" }] }).cacheKey).not.toBe(before);
});

test("known boundary: an in-place rewrite with the same shape is not detected", () => {
	// Same array, same length, same first-block length → same contentId and same
	// metadata hash, so the cache returns the previous object. This is the
	// documented limit of the identity-based revision scheme.
	const message = toolResult({ content: [{ type: "text", text: "aaaa" }] });
	const { runStable } = harness(message);
	const first = runStable();
	expect((message.content[0] as { text: string }).text).toBe("aaaa");
	(message.content[0] as { text: string }).text = "bbbb";
	expect(runStable().cacheKey).toBe(first.cacheKey);
});
