import type { ServerMessage } from "../../server/protocol.js";

type OutputUpdate = Pick<Extract<ServerMessage, { type: "tool_delta" }>, "delta" | "replace">;

const MAX_LIVE_OUTPUT = 200_000;

export function mergeLiveToolOutput(previous: string, update: OutputUpdate): string {
	const text = update.replace ? update.delta : previous + update.delta;
	return text.length > MAX_LIVE_OUTPUT
		? `…[前 ${text.length - MAX_LIVE_OUTPUT} 字符已省略]…\n${text.slice(-MAX_LIVE_OUTPUT)}`
		: text;
}

const MAX_LIVE_LINE = 300;

/** Last non-empty line of (partial) tool output — the running command's progress ticker. */
export function latestOutputLine(text: string): string {
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i].trim();
		if (line) return line.length > MAX_LIVE_LINE ? `…${line.slice(-MAX_LIVE_LINE)}` : line;
	}
	return "";
}
