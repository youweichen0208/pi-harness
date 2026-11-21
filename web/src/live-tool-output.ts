import type { ServerMessage, UiCodemodeDetails } from "../../server/protocol.js";

export interface LiveToolOutput {
	toolName: string;
	/** Browser receipt time; cleared on reconnect. Never inferred from rendered text. */
	lastOutputAt?: number;
	text: string;
	codemode?: UiCodemodeDetails;
}

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

/** Unknown receipt times stay unknown across reloads and reconnects. */
export function outputSilenceSeconds(lastOutputAt: number | undefined, now: number): number | undefined {
	if (lastOutputAt === undefined) return undefined;
	const seconds = Math.max(0, Math.floor((now - lastOutputAt) / 1000));
	return seconds >= 30 ? seconds : undefined;
}

export function observeToolOutput(previous: LiveToolOutput | undefined, update: OutputUpdate & { toolName: string; receivedAt?: number; codemode?: UiCodemodeDetails }): LiveToolOutput {
	const text = mergeLiveToolOutput(previous?.text ?? "", update);
	const newOutput = update.delta.length > 0 && (!update.replace || text !== previous?.text);
	return {
		toolName: update.toolName,
		text,
		lastOutputAt: newOutput ? update.receivedAt : previous?.lastOutputAt,
		codemode: update.codemode ?? previous?.codemode,
	};
}

export function forgetOutputTimes(outputs: Map<string, LiveToolOutput>): Map<string, LiveToolOutput> {
	return new Map([...outputs].map(([id, output]) => [id, { ...output, lastOutputAt: undefined }]));
}
