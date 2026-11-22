/**
 * ANSI escape stripping for the DISPLAY layer only.
 *
 * Raw layers stay untouched: the SDK's `toolResult.content`, persisted
 * `bashExecution.output` and the full-log download all keep their bytes — a
 * download must reproduce what the command actually printed. Both UI paths
 * (live `tool_delta` and the persisted `UiMessage`) go through this one
 * function, so "while running" and "after" cannot diverge.
 *
 * Targeted passes avoid a single general grammar that backtracks over the two
 * escape forms:
 *  1. CSI — `ESC [ params intermediates final`: colour, cursor, erase.
 *  2. OSC — `ESC ] … BEL|ST`: window titles, hyperlinks.
 * Measured on a 1 MB 30-byte-cycle colour log: 1.0 ms vs 6.6 ms for a single
 * GNU-sed-style alternation (which backtracks over the two escape forms).
 */
const CSI = new RegExp("\\u001B\\[[0-?]*[ -/]*[@-~]", "g");
const OSC = new RegExp("\\u001B\\][^\\u0007\\u001B]*(?:\\u0007|\\u001B\\\\)", "g");
/** Single-character escapes: `ESC c`, `ESC 7`, `ESC ( B` (charset selection). */
const SINGLE = new RegExp("\\u001B[()#%*+\\-./][0-9A-Za-z]?|\\u001B[=>NOPZ78c]", "g");
const C1_CSI = new RegExp("\\u009B[0-?]*[ -/]*[@-~]", "g");

export function stripAnsi(text: string): string {
	// Fast path: most tool output carries no escape sequence at all.
	if (!text.includes("\u001b") && !text.includes("\u009b")) return text;
	return text.replace(CSI, "").replace(OSC, "").replace(SINGLE, "").replace(C1_CSI, "");
}
