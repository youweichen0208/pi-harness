const TECHNICAL_LINE = /^(?:[{[<]|const\s|let\s|var\s|function\s|import\s|export\s|return\s|if\s*\(|for\s*\(|while\s*\(|console\.|npm\s|pnpm\s|yarn\s|git\s|cd\s|ls\s|cat\s|grep\s|rg\s|sed\s|awk\s|curl\s|node\s|python\s|pip\s|bash\s|sh\s)/i;
const PATH_ONLY = /^(?:~|\.{0,2}\/|\/|[\w.-]+\/)[\w./\\-]+$/;

export function readableThinkingSummary(thinking: string): string | null {
	const lastLine = thinking.trim().split("\n").at(-1)?.trim() ?? "";
	const summary = lastLine
		.replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/, "")
		.replace(/^`+|`+$/g, "")
		.trim();
	if (!summary || TECHNICAL_LINE.test(summary) || PATH_ONLY.test(summary)) return null;
	if (!/[\p{L}\p{N}]/u.test(summary)) return null;
	if (!/\s/u.test(summary) && !/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(summary)) return null;
	return summary;
}
