export class OutputBudget {
	private used = 0;
	private capped = false;

	constructor(private readonly maxBytes: number) {}

	get bytes(): number {
		return this.used;
	}

	get exceeded(): boolean {
		return this.capped;
	}

	/** Text to forward, which may be a prefix of `chunk`; empty once capped. */
	push(chunk: string): string {
		if (this.capped || !chunk) return "";
		const size = Buffer.byteLength(chunk, "utf8");
		if (this.used + size <= this.maxBytes) {
			this.used += size;
			return chunk;
		}
		this.capped = true;
		const room = this.maxBytes - this.used;
		if (room <= 0) return "";
		// Take the largest prefix that fits, without splitting a character: a
		// half-written multi-byte character would corrupt the stream.
		let characters = 0;
		let bytes = 0;
		for (const character of chunk) {
			const width = Buffer.byteLength(character, "utf8");
			if (bytes + width > room) break;
			bytes += width;
			characters += character.length;
		}
		this.used += bytes;
		return chunk.slice(0, characters);
	}
}

/** Missing imports can require installed packages or a full project. */
export function looksLikeMissingProjectDependency(output: string): boolean {
	return /(?:ModuleNotFoundError|ImportError):/.test(output);
}
