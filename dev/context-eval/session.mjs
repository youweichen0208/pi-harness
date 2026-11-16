import { runWorker } from "./worker-client.mjs";

/** The Node CLI owns cancellation and cleanup; only the bundled Bun worker loads OMP. */
export function runQuestion(config, { signal, ...question }) {
	return runWorker("session", { config, question }, { signal, timeoutMs: config.timeoutMs ?? 120000 });
}
