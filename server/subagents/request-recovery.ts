import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

type Stream = AgentSession["agent"]["streamFunction"];

/** An upstream AbortError is not a user cancellation unless our signal was aborted.
 * Normalize only this missing SDK retry category; native retry owns history/backoff.
 */
export function recoverableSubagentStream(stream: Stream, cancelled: AbortSignal): Stream {
	return async (model, context, options) => {
		const output = new AssistantMessageEventStream();
		const normalize = (message: AssistantMessage): AssistantMessage => {
			if (!cancelled.aborted && !options?.signal?.aborted &&
				(message.stopReason === "aborted" || /\bAbortError\b|\boperation was aborted\b/i.test(message.errorMessage ?? ""))) {
				return { ...message, stopReason: "error", errorMessage: `Stream was interrupted (request abort; exact source unknown): ${message.errorMessage ?? "request aborted"}` };
			}
			return message;
		};
		void (async () => {
			try {
				const input = await stream(model, context, options);
				for await (const event of input) {
					if (event.type === "error") {
						const error = normalize(event.error);
						output.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
					} else output.push(event);
				}
				output.end(normalize(await input.result()));
			} catch (error) {
				const message = normalize({ role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content: [], stopReason: cancelled.aborted || options?.signal?.aborted ? "aborted" : "error", errorMessage: String(error), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
				output.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
			}
		})();
		return output;
	};
}
