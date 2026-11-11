/**
 * Does this reply read as Chinese prose rather than Latin prose?
 *
 * Latin lowercase letters carry ascenders and descenders, so a 1.74 line-height
 * leaves the eye a useful band of white between two lines. Han, kana and hangul
 * fill their whole em box: the same 1.74 reads as loose leading, and a long
 * Chinese paragraph looks airier than an equally long English one. The reply
 * keeps 1.74 by default and tightens only when the text is actually CJK.
 *
 * Classify by content, not by the interface language — a Chinese UI regularly
 * renders English replies, and an English UI renders Chinese ones.
 */

/** Ranges that occupy a full em box and therefore need the tighter leading. */
const CJK =
	/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/u;
/** Anything that counts as a spoken character when weighing the ratio. */
const LETTERISH =
	/[A-Za-z\u00c0-\u024f\u0370-\u058f\u0590-\u06ff\u0900-\u0dff\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/gu;

/**
 * Identifiers count as one token, not as one letter each.
 *
 * `读取 agent_runtime.py 然后修改输出` is a Chinese sentence quoting a filename.
 * Counting every Latin letter gives 17 Latin against 10 Han, which would misfile a
 * plainly Chinese sentence as Latin. Collapsing identifiers first keeps the ratio
 * about how much of the sentence is spoken in which script.
 */
const IDENTIFIER = /[A-Za-z_][\w.-]*|\b\w+\.\w+/gu;

/**
 * Ratio of full-em characters at or above which a block is treated as Chinese.
 *
 * A bilingual paragraph deliberately stays on the Latin setting: mixing scripts
 * inside one paragraph already produces mixed leading, and tightening it would
 * crowd the English words without helping the Chinese ones.
 */
const CJK_RATIO = 0.6;

/** Below this many letters the sample is too small to classify. */
const MIN_SAMPLE = 4;

/**
 * `true` when the block is predominantly CJK. Punctuation, whitespace, digits
 * and code are ignored: a Chinese sentence quoted around an English identifier
 * still qualifies, while a code block full of symbols never does.
 */
export function isCjkDominant(text: string): boolean {
	if (!text) return false;
	const sample = text
		// Fenced code is not prose and must not sway the ratio.
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/`[^`\n]*`/g, " ")
		// An identifier is one word, not a letter-by-letter vote for Latin.
		.replace(IDENTIFIER, "x");
	const letters = sample.match(LETTERISH);
	if (!letters || letters.length < MIN_SAMPLE) return false;
	const cjk = letters.filter((ch) => CJK.test(ch)).length;
	return cjk / letters.length >= CJK_RATIO;
}
