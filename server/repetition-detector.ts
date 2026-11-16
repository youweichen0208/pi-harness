const WINDOW_CHARS = 8192;
const MIN_SAMPLE_CHARS = 1024;
const CHECK_INTERVAL_CHARS = 256;
const MAX_PERIOD_CHARS = 256;
const MIN_CYCLES = 20;

/** An exact periodic suffix must occupy almost the entire observation window.
 * Only a short, non-repeating prefix is tolerated; mismatches inside a cycle
 * are never normalized away. This keeps ordinary prose and similar table rows
 * from looking like a loop. Whitespace alone is not a repetition incident.
 */
function isPeriodic(text: string): boolean {
	if (text.length < MIN_SAMPLE_CHARS || !text.trim()) return false;
	const required = Math.ceil(text.length * 0.95);
	const maxPeriod = Math.min(MAX_PERIOD_CHARS, Math.floor(text.length / MIN_CYCLES));
	for (let period = 1; period <= maxPeriod; period++) {
		let start = text.length - period;
		while (start > 0 && text.charCodeAt(start - 1) === text.charCodeAt(start - 1 + period)) start--;
		const repeated = text.length - start;
		if (repeated >= required && repeated >= period * MIN_CYCLES && text.slice(-period).trim()) return true;
	}
	return false;
}

/** Incremental, bounded detector for ONE assistant content block. Checkpoints
 * depend on accepted characters rather than network chunks, so a whole-message
 * delta and one-character deltas produce the same verdict. A second checkpoint
 * confirms that generation continued repeating for at least 256 characters.
 * Window sizes are UTF-16 code units, matching SDK string deltas.
 */
export class RepetitionDetector {
	private tail = "";
	private pending = "";
	private candidate = false;
	private detected = false;
	private afterCarriageReturn = false;
	private prefix = "";
	private proseLine = false;
	private fence?: { marker: string; length: number };
	private openingLine = false;
	private openingRun = false;
	private closingState: "indent" | "markers" | "trailing" | "invalid" = "indent";
	private closingIndent = 0;
	private closingCount = 0;

	constructor(private readonly channel: "text" | "thinking") {}

	push(delta: string): boolean {
		if (this.detected) return true;
		for (let index = 0; index < delta.length; index++) {
			const raw = delta[index];
			if (raw === "\n" && this.afterCarriageReturn) {
				this.afterCarriageReturn = false;
				continue;
			}
			this.afterCarriageReturn = raw === "\r";
			const character = raw === "\r" ? "\n" : raw;
			if (this.channel === "thinking") this.accept(character);
			else this.acceptText(character);
			if (this.detected) return true;
		}
		return false;
	}

	private accept(text: string): void {
		for (const character of text) {
			this.pending += character;
			if (this.pending.length < CHECK_INTERVAL_CHARS) continue;
			this.tail = (this.tail + this.pending).slice(-WINDOW_CHARS);
			this.pending = "";
			const repeated = isPeriodic(this.tail);
			this.detected = this.candidate && repeated;
			this.candidate = repeated;
			if (this.detected) return;
		}
	}

	/** Fence recognition retains only a bounded prefix and scalar state, including
	 * across chunks and very long code lines. Excluded code also breaks a prose
	 * candidate: text on opposite sides of a fence must not form a fake cycle.
	 */
	private acceptText(character: string): void {
		if (this.fence) {
			if (this.openingLine) {
				if (character === "\n") {
					this.openingLine = false;
					this.openingRun = false;
				} else if (this.openingRun && character === this.fence.marker) {
					this.fence.length++;
				} else this.openingRun = false;
				return;
			}
			if (character === "\n") {
				if ((this.closingState === "markers" || this.closingState === "trailing") && this.closingCount >= this.fence.length) this.fence = undefined;
				this.closingState = "indent";
				this.closingIndent = this.closingCount = 0;
			} else if (this.closingState === "indent") {
				if (character === " " && this.closingIndent < 3) this.closingIndent++;
				else if (character === this.fence.marker) {
					this.closingState = "markers";
					this.closingCount = 1;
				} else this.closingState = "invalid";
			} else if (this.closingState === "markers") {
				if (character === this.fence.marker) this.closingCount++;
				else this.closingState = character === " " || character === "\t" ? "trailing" : "invalid";
			} else if (this.closingState === "trailing" && character !== " " && character !== "\t") this.closingState = "invalid";
			return;
		}
		if (this.proseLine || character === "\n") {
			this.accept(this.prefix + character);
			this.prefix = "";
			this.proseLine = character !== "\n";
			return;
		}
		const prefix = this.prefix + character;
		const opener = /^ {0,3}(`{3}|~{3})$/.exec(prefix);
		if (opener) {
			this.fence = { marker: opener[1][0], length: 3 };
			this.openingLine = this.openingRun = true;
			this.prefix = this.tail = this.pending = "";
			this.candidate = false;
		} else if (/^ {0,3}(?:`{1,2}|~{1,2})?$/.test(prefix)) {
			this.prefix = prefix;
		} else {
			this.accept(prefix);
			this.prefix = "";
			this.proseLine = true;
		}
	}
}
