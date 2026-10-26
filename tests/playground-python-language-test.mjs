/** Requires a selected Python environment with Jedi and Black installed. */
import assert from "node:assert/strict";
import { playgroundFixture } from "./lib/playground-fixture.mjs";
const fixture = await playgroundFixture({ PI_WEB_PYTHON: process.env.PI_WEB_PYTHON });
try {
	await fixture.api("config", { enabled: false });
	const request = async (code, action, offset = code.length) => {
		const response = await fixture.api("language", { id: "python-language-test", code, action, offset });
		assert.equal(response.status, 200, response.status === 200 ? "" : await response.text());
		return response.json();
	};
	const completion = await request('message = "hello"\nmessage.upp', "completion");
	assert(completion.items.some(item => item.label === "upper"));
	const emoji = 'message = "🐍"; message.upp';
	const unicode = await request(emoji, "completion");
	assert.equal(unicode.items.find(item => item.label === "upper").edit.from, emoji.lastIndexOf("upp"));
	const signature = await request("def add(a: int, b: int):\n    return a+b\nadd(", "signature");
	assert(signature.signatures.some(s => s.includes("add") && s.includes("a")));
	assert((await request("def broken(:", "diagnostics")).diagnostics.length);
	assert.deepEqual((await request('raise RuntimeError("must not execute")', "diagnostics")).diagnostics, []);
	const formatted = await fixture.api("format", { code: "def add(a,b):\n return a+b" });
	assert.equal(formatted.status, 200); assert.match((await formatted.json()).code, /def add\(a, b\):\n    return a \+ b/);
	assert.equal((await fixture.api("format", { code: "def broken(:" })).status, 422);
	assert.equal((await fixture.api("format", { code: "print(1)", extra: true })).status, 400);
	assert.equal((await fixture.api("language", { code: "x", offset: 3, action: "completion" })).status, 400);
	assert.equal((await fixture.api("language", { code: "x", offset: 0, action: "execute" })).status, 400);
	console.log("PASS real Python Jedi/Black: completion, UTF-16 edits, signatures, diagnostics, no source execution, format and API validation with execution disabled");
} finally { await fixture.stop(); }
