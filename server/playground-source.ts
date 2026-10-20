/**
 * Pure rules for turning a pasted Java source into "what file to write and what
 * class to run", plus the output accounting a Run needs.
 *
 * No process and no I/O live here on purpose: these are the rules with real edge
 * cases, and keeping them pure means they are covered by CI even though CI has
 * no JDK and therefore cannot exercise an actual Run.
 */

export interface JavaSource {
	/** Top-level type the file is named after. */
	typeName: string;
	/** Dotted package declaration, when the source has one. */
	packageName?: string;
	/** Source path relative to the Run's temp directory, always forward-slashed. */
	fileName: string;
	/** Fully qualified class handed to `java`. */
	mainClass: string;
}

/**
 * Blank out comments and string/char literals, preserving offsets and newlines,
 * so a declaration mentioned in a comment or a string cannot be mistaken for the
 * real thing. Handles `//`, `/* *\/`, `"…"`, `'…'` and `"""` text blocks.
 */
function blankNonCode(source: string): string {
	const out = [...source];
	const length = source.length;
	const blank = (from: number, to: number) => {
		for (let index = from; index < to; index++) if (out[index] !== "\n") out[index] = " ";
	};
	let index = 0;
	while (index < length) {
		const character = source[index];
		const next = source[index + 1];
		if (character === "/" && next === "/") {
			const end = source.indexOf("\n", index);
			const to = end === -1 ? length : end;
			blank(index, to);
			index = to;
			continue;
		}
		if (character === "/" && next === "*") {
			const end = source.indexOf("*/", index + 2);
			const to = end === -1 ? length : end + 2;
			blank(index, to);
			index = to;
			continue;
		}
		if (character === '"' && source.startsWith('"""', index)) {
			let scan = index + 3;
			while (scan < length && !(source.startsWith('"""', scan) && source[scan - 1] !== "\\")) scan++;
			const to = Math.min(length, scan + 3);
			blank(index, to);
			index = to;
			continue;
		}
		if (character === '"' || character === "'") {
			let scan = index + 1;
			while (scan < length) {
				if (source[scan] === "\\") { scan += 2; continue; }
				if (source[scan] === character) { scan++; break; }
				if (source[scan] === "\n") break;
				scan++;
			}
			const to = Math.min(scan, length);
			blank(index, to);
			index = to;
			continue;
		}
		index++;
	}
	return out.join("");
}

const PACKAGE = /\bpackage\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*;/;
const PUBLIC_TYPE = /\bpublic\s+(?:(?:final|abstract|sealed|non-sealed|strictfp|static)\s+)*(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)/;

/**
 * Java names the file after the public top-level type, so the runner has to
 * find it. The first public type wins; without one the file is `Main.java`,
 * which is what `javac` accepts for a package-private class.
 */
export function introspectJavaSource(source: string): JavaSource {
	const code = blankNonCode(source);
	const packageName = PACKAGE.exec(code)?.[1]?.replace(/\s+/g, "");
	const typeName = PUBLIC_TYPE.exec(code)?.[2] ?? "Main";
	const directory = packageName ? `${packageName.replace(/\./g, "/")}/` : "";
	return {
		typeName,
		packageName,
		fileName: `${directory}${typeName}.java`,
		mainClass: packageName ? `${packageName}.${typeName}` : typeName,
	};
}

/**
 * Byte budget for one Run's combined stdout and stderr. Once the cap is crossed
 * the caller kills the process — a `while (true) System.out.println()` must not
 * be allowed to run to the timeout — so this only has to account and truncate.
 */
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

/**
 * Whether a compile failure is the "this file needs the rest of the project"
 * kind rather than a mistake in the snippet. Runs compile in isolation, so a
 * reference to a sibling class shows up as a missing symbol or package; that
 * deserves a plain-language explanation instead of a raw javac dump.
 */
export function looksLikeMissingProjectDependency(output: string): boolean {
	if (/\bpackage\s+[\w.]+\s+does not exist\b/.test(output)) return true;
	return /cannot find symbol[\s\S]{0,400}?\bsymbol:\s*(?:class|interface|enum|record)\b/.test(output);
}
