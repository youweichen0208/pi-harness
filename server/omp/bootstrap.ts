import type { OpenAIProxyConfig } from "../protocol.js";
/** Host-owned startup contract, intentionally independent of OMP SDK types. */
export const OMP_BRIDGE_VERSION = 1;
export const OMP_VERSION = "18.20.0";
export const BUN_VERSION = "1.4.4";
export interface OmpBootstrap {
	version: typeof OMP_BRIDGE_VERSION;
	/** Internal metadata-only invocation; never constructs an agent or calls a model. */
	operation?: "latest_history" | "tool_output" | "projects" | "delete_history" | "tree_read";
	toolCallId?: string;
	outputTask?: import("./tool-output.js").OmpTaskOutputPath;
	treeQuery?: { filter: string; query: string; previewTarget?: string; memory?: boolean; leafId?: string | null; sessionId?: string };
	cwd: string;
	agentDir: string;
	openAIProxy?: OpenAIProxyConfig;
	sessionDir: string;
	sessionFile?: string;
	/** Internal acknowledgement captured by an explicit host reopen, never a browser option. */
	recoveryTokens?: string[];
	model?: string;
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
	/** Restricted business sessions expose only host tools registered after startup. */
	restricted?: { systemPrompt: string; toolNames: string[] };
}
