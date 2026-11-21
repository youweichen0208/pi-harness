import type { NotebookCellOutput, NotebookRunEvent, NotebookRunResult, WikiApiError } from "./types";
export class WikiRequestError extends Error {
	constructor(public readonly detail: WikiApiError) { super(detail.error); }
}
import { withToken } from "./auth-token";
import { getClientId } from "./use-chat";
export async function wikiRequest<T>(cwd: string, action: string, args: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
	const response = await fetch(withToken("/api/wiki"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...args, clientId: getClientId(), cwd, action }), keepalive: action === "notebook-close", signal });
	const data = await response.json();
	if (!response.ok) throw new WikiRequestError({ ...data, error: data.error || response.statusText });
	return data;
}
export function wikiMedia(cwd: string, path: string, download = false): string {
	return withToken("/api/wiki-media?" + new URLSearchParams({ clientId: getClientId(), cwd, path, ...(download ? { download: "1" } : {}) }));
}

export async function runNotebookCell(cwd: string, args: Record<string, unknown>, onOutput: (output: NotebookCellOutput) => void): Promise<NotebookRunResult> {
	const response = await fetch(withToken("/api/wiki"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...args, clientId: getClientId(), cwd, action: "notebook-run" }) });
	if (!response.ok || !response.body) throw new Error((await response.json()).error || response.statusText);
	const reader = response.body.getReader(), decoder = new TextDecoder();
	let buffer = "";
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) throw new Error("Notebook execution disconnected");
			buffer += decoder.decode(chunk.value, {stream:true});
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const event = JSON.parse(buffer.slice(0,newline)) as NotebookRunEvent; buffer = buffer.slice(newline+1);
				if ("error" in event) throw new Error(event.error);
				if ("result" in event) return event.result;
				onOutput(event.output);
			}
		}
	} finally { reader.releaseLock(); }
}
