/**
 * Format painter rules, expressed without touching the DOM.
 *
 * The painter samples one place and applies the result somewhere else. What it
 * may copy is exactly the persistable format set — the properties `cleanStyle`
 * accepts — so anything painted here survives a save and reopen. Splitting a
 * single style string into inline and block domains is the whole reason this
 * module exists: `cleanStyle` returns one flat string, but the painter has to
 * apply inline properties to text spans and block properties to the block.
 *
 * This module stays free of DOM types so it can be unit tested in a node
 * environment. Callers clean their style strings through `cleanStyle` first.
 */

/** Properties that describe a run of characters, not the block holding them. */
const INLINE_KEYS = ["font-size", "color", "background-color", "font-weight", "font-style", "text-decoration"] as const;
/** Properties that describe the block itself. */
const BLOCK_KEYS = ["text-align", "line-height"] as const;
export type InlineKey = (typeof INLINE_KEYS)[number];
export type BlockKey = (typeof BLOCK_KEYS)[number];
type Declarations = Partial<Record<InlineKey | BlockKey, string>>;

export interface FormatSample {
	/** Character formatting, applied to a text selection. */
	inline: Declarations;
	/** Block formatting, applied to the whole target block. */
	block: Declarations;
	/** Source block tag lowered; `p` for anything that is not a heading. */
	tag: string;
}

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

/** Parse one `property: value; property: value` string into typed declarations. */
function parse(style: string): Declarations {
	const result: Declarations = {};
	for (const declaration of style.split(";")) {
		const index = declaration.indexOf(":");
		if (index < 0) continue;
		const key = declaration.slice(0, index).trim();
		const value = declaration.slice(index + 1).trim();
		if (!value) continue;
		if ((INLINE_KEYS as readonly string[]).includes(key) || (BLOCK_KEYS as readonly string[]).includes(key)) result[key as InlineKey | BlockKey] = value;
	}
	return result;
}

/** Serialise declarations back into a CSS text value; empty input yields "". */
export function declare(declarations: Declarations): string {
	return Object.entries(declarations).map(([key, value]) => `${key}: ${value}`).join("; ");
}

/**
 * Split a raw CSS text into the inline and block domains.
 *
 * The input is round-tripped through `cleanStyle` first, so a sampled style can
 * never contain a property the document format would drop later.
 */
export function splitStyle(style: string): { inline: Declarations; block: Declarations } {
	const declarations = parse(style);
	const inline: Declarations = {};
	const block: Declarations = {};
	for (const key of INLINE_KEYS) if (declarations[key]) inline[key] = declarations[key];
	for (const key of BLOCK_KEYS) if (declarations[key]) block[key] = declarations[key];
	return { inline, block };
}

/** Build a sample from the persistable subset of a style string plus its block tag. */
export function sampleFormat(style: string, tag: string): FormatSample {
	const lowered = tag.toLowerCase();
	const { inline, block } = splitStyle(style);
	return { inline, block, tag: HEADINGS.has(lowered) ? lowered : "p" };
}

/**
 * Replace a block's block-level declarations with the sample's.
 *
 * Replacement, not merging: painting means "make this block look like that one",
 * so a property the source does not carry is removed from the target rather than
 * left behind. Inline declarations already present in `target` are untouched —
 * they are represented as child spans, never as block style.
 */
export function mergeBlockFormat(target: string, sample: Declarations): string {
	const current = parse(target);
	const next: Declarations = {};
	for (const key of BLOCK_KEYS) {
		const value = sample[key];
		if (value) next[key] = value;
		else delete current[key];
	}
	for (const key of BLOCK_KEYS) if (current[key] && !next[key]) next[key] = current[key];
	return declare(next);
}

/** The declarations a block should end up with after painting. */
export function paintedBlockStyle(sample: FormatSample): string {
	return declare(sample.block);
}

/** Copy paragraph/heading types in either direction without destroying lists or cells. */
export function canReplaceBlockTag(from: string, to: string): boolean {
	const source = to.toLowerCase(), target = from.toLowerCase();
	return (target === "p" || HEADINGS.has(target)) && (source === "p" || HEADINGS.has(source)) && source !== target;
}

/** Whether sampling produced anything at all; false means "nothing to copy". */export function isEmptySample(sample: FormatSample): boolean {
	return !Object.keys(sample.inline).length && !Object.keys(sample.block).length;
}

/**
 * Keep only the declarations that differ from an inherited baseline.
 *
 * `getComputedStyle` reports the *resolved* value of every property, so a plain
 * paragraph still "has" a font size, a colour and `font-style: normal`. Painting
 * those verbatim would stamp apparent formatting onto blocks the user never
 * styled, and the noise would survive a save. Diffing against the block's own
 * baseline leaves only what the author actually set.
 */
export function diffAgainstBaseline(sample: FormatSample, baseline: FormatSample): FormatSample {
	const pick = <T extends object>(value: T, base: T) => Object.fromEntries(
		Object.entries(value).filter(([key, setting]) => setting !== (base as Record<string, unknown>)[key]),
	) as T;
	return { inline: pick(sample.inline, baseline.inline), block: pick(sample.block, baseline.block), tag: sample.tag };
}
