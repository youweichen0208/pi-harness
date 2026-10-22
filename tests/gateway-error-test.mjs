// Inject native event fixtures at the host boundary; never call a model.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientSession } from "../dist/server/agent-service.js";
import { ClientStateStore } from "../dist/server/client-state.js";
import { scrubHostEnv } from "./lib/test-env.mjs";
import { ThinkingDurationStore } from "../dist/server/thinking-timing.js";
scrubHostEnv();
const root = mkdtempSync(join(tmpdir(), "pi-gateway-error-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent"); mkdirSync(process.env.PI_CODING_AGENT_DIR);
let cs;
try {
	cs = await ClientSession.create("recovery", root, new ClientStateStore(join(root, "state.json")), new ThinkingDurationStore(join(root, "thinking.json")));
	const conv = cs.conv;
	const manager = conv.session.sessionManager;
	const user = { role: "user", content: "hello", timestamp: 1 };
	const error = { role: "assistant", content: [], timestamp: 2, api: "openai-completions", provider: "fixture", model: "fixture", stopReason: "error", errorMessage: "413 Input prompt too long", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
	manager.appendMessage(user);
	const errorId = manager.appendMessage(error);
	manager.appendContextEdit(errorId, null);
	conv.session.agent.state.messages.splice(0, conv.session.agent.state.messages.length, ...manager.buildSessionContext().messages);
	const visible = cs.currentMessages();
	assert.equal(visible.filter(m => m.errorMessage === error.errorMessage).length, 1, "context-erased 413 must remain visible exactly once");
	assert.equal(conv.session.agent.state.messages.some(m => m.stopReason === "error"), false, "display must not restore errors to model context");
	manager.appendMessage({ role: "user", content: "again", timestamp: 3 });
	conv.session.agent.state.messages.splice(0, conv.session.agent.state.messages.length, ...manager.buildSessionContext().messages);
	assert.equal(cs.currentMessages().at(-2).errorMessage, error.errorMessage, "error stays next to its failed request");
	manager.branch(errorId);
	conv.session.agent.state.messages.splice(0, conv.session.agent.state.messages.length, ...manager.buildSessionContext().messages);
	assert.equal(cs.currentMessages().filter(m => m.errorMessage).length, 1, "unmodified branch does not duplicate its error");
	manager.resetLeaf(); manager.appendMessage({ role: "user", content: "other branch", timestamp: 4 });
	conv.session.agent.state.messages.splice(0, conv.session.agent.state.messages.length, ...manager.buildSessionContext().messages);
	assert.equal(cs.currentMessages().some(m => m.errorMessage), false, "other branches cannot leak errors");
	console.log("PASS gateway errors survive context removal for UI only and stay branch-local");
} finally { await cs?.dispose(); rmSync(root, { recursive: true, force: true }); }
