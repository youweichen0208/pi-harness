/** File-backed native extension so Task worker threads can load the same observer. */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { isMainThread } from "node:worker_threads";
import { diagnosticEvent } from "../model-diagnostics.js";
import { createRequestDiagnostics } from "./request-diagnostics.js";

export default function requestDiagnostics(api: ExtensionAPI) {
	const trace = createRequestDiagnostics(process.env.HARNESS_OMP_REQUEST_DIAGNOSTICS_DIR);
	if (!trace) return;
	let request = 0;
	const runId = process.env.HARNESS_OMP_DIAGNOSTICS_RUN;
	const metadata = (ctx: ExtensionContext) => ({
		engine: "omp", runId: runId && /^[a-f0-9-]{36}$/.test(runId) ? runId : undefined, session: trace.digest(ctx.sessionManager.getSessionId()),
		agent: ctx.agent.kind, depth: ctx.agent.depth, agentId: trace.digest(ctx.agent.id), parentAgentId: trace.digest(ctx.agent.parentId), workerThread: !isMainThread,
		model: trace.digest(ctx.model?.id), provider: trace.digest(ctx.model?.provider), endpoint: trace.digest(ctx.model?.baseUrl),
		api: ["anthropic-messages", "openai-completions", "openai-responses", "openai-codex-responses", "google-generative-ai", "google-vertex"].includes(ctx.model?.api ?? "") ? ctx.model!.api : "other",
	});
	api.on("before_provider_request", (event, ctx) => {
		try { trace.write({ type: "before_provider_request", request: ++request, ...metadata(ctx), payload: trace.project(event.payload) }); } catch { /* Diagnostics must not affect the request. */ }
		// Returning undefined preserves this exact payload for subsequent native hooks.
	});
	api.on("after_provider_response", (event, ctx) => {
		try { trace.write({ type: "after_provider_response", ...metadata(ctx), status: Number.isInteger(event.status) && event.status >= 100 && event.status <= 599 ? event.status : undefined }); } catch { /* No headers, body or request IDs. */ }
	});
	api.on("message_update", (event, ctx) => {
		try { trace.write({ ...metadata(ctx), ...diagnosticEvent(event) }); } catch { /* Observer only; parallel requests cannot be paired by a global counter. */ }
	});
	api.on("message_end", (event, ctx) => {
		try { trace.write({ ...metadata(ctx), ...diagnosticEvent(event) }); } catch { /* Observer only. */ }
	});
}
