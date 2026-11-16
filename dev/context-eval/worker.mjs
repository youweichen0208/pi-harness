import { createInterface } from "node:readline";
import { rm } from "node:fs/promises";

// stdout carries a single result, never SDK logging or credentials in diagnostics.
console.log = console.info = console.debug = (...values) => console.error(...values);
const controller = new AbortController();
const lines = createInterface({ input: process.stdin });
let started = false;
lines.on("line", line => {
	const input = JSON.parse(line);
	if (input.abort) { controller.abort(new Error("Evaluation cancelled")); return; }
	if (started) return;
	started = true;
	void (async () => {
		let response, code = 0;
		try {
			let result;
			if (input.operation === "session") {
				const { runQuestion } = await import("./session-worker.mjs");
				result = await runQuestion(input.config, { ...input.question, signal: controller.signal });
			} else if (input.operation === "model") {
				const { resolveOmpModel } = await import("./model-worker.mjs");
				result = await resolveOmpModel(input.selection);
			} else throw new Error("Unknown evaluation operation");
			response = { result };
		} catch (error) {
			response = { error: error.message, result: error.result };
			code = 1;
		} finally {
			// Also clean up if the coordinator has gone away and cannot run its finally block.
			await rm(process.env.CONTEXT_EVAL_DIRECTORY, { recursive: true, force: true });
		}
		await new Promise(resolve => process.stdout.write(JSON.stringify(response), resolve));
		process.exit(code);
	})();
});
lines.on("close", () => controller.abort(new Error("Evaluation host disconnected")));
