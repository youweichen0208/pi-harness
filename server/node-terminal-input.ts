/** Separate terminal replies from editable input without changing bytes sent to SSH. */
export class NodeTerminalInput {
	private outputTail = "";
	private cursorQueries: { extended: boolean; expires: number }[] = [];
	constructor(private readonly now: () => number = Date.now) {}

	observeOutput(data: string): void {
		const output = this.outputTail + data;
		this.prune();
		for (const match of output.matchAll(/\x1b\[(\?)?6n/g)) {
			this.cursorQueries.push({ extended: !!match[1], expires: this.now() + 5000 });
		}
		this.cursorQueries = this.cursorQueries.slice(-16);
		// Only retain an incomplete query, never a completed sequence twice.
		this.outputTail = output.match(/\x1b(?:\[(?:\??6?)?)?$/)?.[0] ?? "";
	}

	/** xterm onData emits whole replies; mixed events retain their user-input part. */
	userInput(data: string): string {
		this.prune();
		const input = data.replace(/\x1b\[[IO]|\x1b\[(\?)?\d+;\d+R/g, (report, extended: string | undefined) => {
			if (report === "\x1b[I" || report === "\x1b[O") return "";
			const index = this.cursorQueries.findIndex(query => query.extended === !!extended);
			// Unsolicited CPR-shaped input may be a modified function key.
			if (index < 0) return report;
			this.cursorQueries.splice(index, 1);
			return "";
		});
		if (input) this.cursorQueries = [];
		return input;
	}

	private prune(): void {
		this.cursorQueries = this.cursorQueries.filter(query => query.expires > this.now());
	}
}
