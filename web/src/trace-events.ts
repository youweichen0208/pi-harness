import type { TraceResult } from "./types";

export function emitTraceResponse(message: TraceResult) {
	window.dispatchEvent(new CustomEvent<TraceResult>("pi-trace-response", { detail: message }));
	if (message.open) window.dispatchEvent(new Event("pi-trace-open"));
}

export function openTrace() {
	window.dispatchEvent(new Event("pi-trace-open"));
}
