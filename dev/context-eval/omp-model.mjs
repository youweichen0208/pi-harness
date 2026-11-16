import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { runWorker } from "./worker-client.mjs";

export function resolveOmpModel(selection, baseDir) {
	const agentDir = selection.agentDir ? resolve(baseDir, selection.agentDir) : join(homedir(), ".omp", "agent");
	return runWorker("model", { selection: { ...selection, agentDir } });
}
