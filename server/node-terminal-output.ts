/** Frame a shared PTY command without leaking its shell wrapper into the UI or
 * model output. Markers can arrive in arbitrary SSH packet boundaries. */
export class NodeTerminalOutput {
	private buffer = "";
	private started = false;
	private output = "";
	private truncated = false;
	constructor(private readonly start: string, private readonly end: string) {}
	push(data: string): { display: string; result?: { output: string; code: number } } {
		this.buffer += data;
		if (!this.started) {
			const match = new RegExp(`(?:^|\\r?\\n)${this.start}\\r?\\n`).exec(this.buffer);
			if (!match) { this.buffer = this.buffer.slice(-Math.max(this.start.length + 4, 65536)); return { display: "" }; }
			this.buffer = this.buffer.slice(match.index + match[0].length);
			this.started = true;
		}
		const end = new RegExp(`\\r?\\n${this.end}:(\\d+)\\r?\\n`).exec(this.buffer);
		const count = end ? end.index : Math.max(0, this.buffer.length - this.end.length - 24);
		const display = this.buffer.slice(0, count);
		this.output += display;
		if (Buffer.byteLength(this.output) > 65536) { this.output = Buffer.from(this.output).subarray(-65536).toString("utf8"); this.truncated = true; }
		if (end) {
			const rest = this.buffer.slice(end.index + end[0].length);
			this.buffer = "";
			return { display: display + rest, result: { output: (this.truncated ? "[输出已截断]\n" : "") + this.output, code: Number(end[1]) } };
		}
		this.buffer = this.buffer.slice(count);
		return { display };
	}
}
