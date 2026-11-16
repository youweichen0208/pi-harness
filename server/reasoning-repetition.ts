/** Structural stream boundary, shared by the native OMP bridge and legacy tests. */
export interface ReasoningStreamEvent { type: string; assistantMessageEvent?: unknown; }

const WINDOW_CHARS = 8192;
const CHECK_EVERY = 256;
const MIN_CHARS = 2048;
const GRAM = 8;

/** Conservative saturation check: a long thinking tail is almost entirely the
 * same word sequences, repeated at least four times. Not a reasoning budget. */
export function repetitiveReasoning(text: string): boolean {
	const tail = text.slice(-WINDOW_CHARS);
	if (tail.length < MIN_CHARS) return false;
	// Segment Han characters as well as whitespace-delimited languages. Retain
	// numbers and punctuation so lists, counters and code are not conflated.
	const tokens = (tail.match(/\p{Script=Han}|[\p{L}\p{N}_]+|[^\s]/gu) ?? []).slice(-1024);
	if (tokens.length < 256) return false;
	const counts = new Map<string, number>();
	const grams: string[] = [];
	for (let i = 0; i <= tokens.length - GRAM; i++) {
		const key = JSON.stringify(tokens.slice(i, i + GRAM));
		grams.push(key); counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	return grams.filter(key => counts.get(key)! >= 4).length / grams.length >= 0.95;
}

/** Per subscription, per assistant message/block; no transcript scanning on each
 * token, no timers and bounded memory even for very large provider chunks. */
export class ReasoningRepetitionWatchdog {
	private tail = "";
	private unchecked = 0;
	private index = -1;
	private triggered = false;

	observe(event: ReasoningStreamEvent): boolean {
		if (event.type === "message_start" || event.type === "agent_settled" || event.type === "session_settled") {
			this.tail = ""; this.unchecked = 0; this.index = -1; this.triggered = false;
		}
		if (event.type !== "message_update" || this.triggered) return false;
		const raw = event.assistantMessageEvent;
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
		const delta = raw as Record<string, unknown>;
		if (delta.type !== "thinking_delta") {
			if (delta.type === "text_start" || delta.type === "toolcall_start" || delta.type === "thinking_end") {
				this.tail = ""; this.unchecked = 0; this.index = -1;
			}
			return false;
		}
		if (typeof delta.delta !== "string" || typeof delta.contentIndex !== "number" || !Number.isSafeInteger(delta.contentIndex) || delta.contentIndex < 0) return false;
		if (this.index !== delta.contentIndex) {
			this.tail = ""; this.unchecked = 0; this.index = delta.contentIndex;
		}
		// Check within large chunks too: a non-repeating suffix must not conceal
		// a runaway sequence that happened to arrive in a single network packet.
		for (let offset = 0; offset < delta.delta.length; offset += CHECK_EVERY) {
			const part = delta.delta.slice(offset, offset + CHECK_EVERY);
			this.tail = (this.tail + part).slice(-WINDOW_CHARS);
			this.unchecked += part.length;
			if (this.unchecked < CHECK_EVERY) continue;
			this.unchecked = 0;
			if (repetitiveReasoning(this.tail)) { this.triggered = true; return true; }
		}
		return false;
	}
}
