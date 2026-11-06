/** Structured questions in an assistant reply (4a): `❓ **Q1** - **Title**：prompt`,
 * inline `(a) …;(b) …` options and a `➡️ 推荐 (c)。reason` recommendation. */
export interface QuestionOption {
	/** Letter from the reply, or undefined when an open question's recommendation is the option. */
	key?: string;
	text: string;
	recommended?: boolean;
	/** Why it is recommended (recommended option only). */
	reason?: string;
}

export interface QuestionCard {
	id: string;
	title: string;
	prompt: string;
	note?: string;
	options: QuestionOption[];
}

/** Answer index for the free-text "其他" row every card ends with. */
export const OTHER_ANSWER = -1;

export type ReplySegment = { kind: "markdown"; text: string } | { kind: "questions"; questions: QuestionCard[] };

const QUESTION = /^\s*❓️?\s*/;
const NOTE = /^\s*(?:⚠️?\s*|\*\*注意\*\*\s*[:：]?\s*|注意[:：]\s*)(.+)$/;
const RECOMMEND = /^\s*➡️?\s*/;

const plain = (text: string) => text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/`([^`]+)`/g, "$1").trim();

function parseHead(line: string, index: number) {
	const body = line.replace(QUESTION, "");
	const boldHead = /^\*\*(Q\d+[a-z]?)\s*[-–—:：.]\s*(.+?)\*\*\s*[:：]?\s*(.*)$/.exec(body);
	if (boldHead) return { id: boldHead[1], title: plain(boldHead[2]), prompt: boldHead[3] };
	const id = /\*{0,2}(Q\d+[a-z]?)\*{0,2}/.exec(body)?.[1] ?? `Q${index + 1}`;
	const rest = body.replace(/^\*{0,2}Q\d+[a-z]?\*{0,2}\s*[-–—:：.]?\s*/, "");
	const titled = /^\*\*([^*]+)\*\*\s*[:：]?\s*(.*)$/.exec(rest);
	return titled ? { id, title: plain(titled[1]), prompt: titled[2] } : { id, title: "", prompt: rest };
}

/** A list-style option line, after removing inline emphasis: `- **A.** text`, `A) text` or `(a) text`. */
const LIST_OPTION = /^\s*(?:[-–—*]\s*)?(?:(?:[(（]([A-Ha-h])[)）]|([A-Ha-h])[.、．)）])\s+|([A-Ha-h])[:：]\s*)(.+)$/;

/** Split `(a) x;(b) y;(c) z。trailing` into options; text before (a) and after the last option's sentence stays prompt. */
function parseOptions(text: string) {
	// Inline choices are separated by semicolons. Parenthesized letters inside
	// an option (for example `(c) (b) + …`) are references, not new choices.
	const markers = [...text.matchAll(/[(（]([A-Ha-h])[)）]\s*/g)]
		.filter((match, index) => index === 0 || /[;；]\s*$/.test(text.slice(0, match.index)));
	const parts = [text.slice(0, markers[0]?.index ?? text.length)];
	for (let i = 0; i < markers.length; i++) {
		const marker = markers[i];
		parts.push(marker[1], text.slice(marker.index + marker[0].length, markers[i + 1]?.index));
	}
	if (parts.length < 5) return { prompt: text, options: [] as QuestionOption[] };
	const options: QuestionOption[] = [];
	let trailing = "";
	for (let i = 1; i < parts.length; i += 2) {
		let option = parts[i + 1].trim().replace(/[;；]\s*$/, "");
		if (i + 2 >= parts.length) {
			const end = option.search(/[。？?](?=.)/);
			if (end >= 0) { trailing = option.slice(end + 1).trim(); option = option.slice(0, end); }
		}
		options.push({ key: parts[i].toLowerCase(), text: plain(option.replace(/[。;；]\s*$/, "")) });
	}
	return { prompt: [parts[0].trim(), trailing].filter(Boolean).join(" "), options };
}

function applyRecommendation(options: QuestionOption[], text: string): QuestionOption[] {
	const body = plain(text).replace(/^推荐\s*[:：]?\s*/, "").replace(/^Recommend(?:ed|ation)?\s*[:：]?\s*/i, "");
	const keyed = /^[(（]?([A-Ha-h])[)）.、．：:]?\s*(.*)$/.exec(body);
	const reason = (keyed ? keyed[2] : "").replace(/^[。.,，:：;；\s]+/, "");
	const picked = keyed && options.find(option => option.key === keyed[1].toLowerCase());
	if (picked) { picked.recommended = true; if (reason) picked.reason = reason; return options; }
	if (options.length) return options;
	// Open question: the recommendation is the preselected option; the card's "其他" row covers everything else.
	const cut = body.search(/[。：:；;]/);
	const answer = (cut > 0 ? body.slice(0, cut) : body).trim();
	const why = cut > 0 ? body.slice(cut + 1).trim() : "";
	return answer ? [{ text: answer, recommended: true, ...(why ? { reason: why } : {}) }] : [];
}

/** Only turn an explicit final offer into choices; explanatory A/B lists stay prose. */
function trailingOffer(text: string): ReplySegment[] | undefined {
	const trimmed = text.trimEnd();
	const lines = trimmed.split("\n");
	let fence: { char: string; length: number } | undefined;
	for (const line of lines) {
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (!marker) continue;
		if (!fence) fence = { char: marker[0], length: marker.length };
		else if (marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = undefined;
	}
	const last = lines.at(-1) ?? "";
	if (fence || /^\s*(?:>|[-*#]|\d+[.)])/.test(last) || /^\s{4}/.test(last)) return;
	const match = /(?:^|[。！？])\s*((?:要我|需要我|你希望我)([^？?\n]+?)[，,]\s*还是([^？?\n]+)[？?])$/.exec(last)
		?? /(?:^|[.!?]\s+)\s*((?:Would you like me to|Do you want me to)\s+([^?\n]+?),\s+or\s+([^?\n]+)\?)$/i.exec(last);
	if (!match || /还是|\bor\b/i.test(match[2] + match[3])) return;
	const options = [match[2], match[3]].map((value, index) => ({ key: index === 0 ? "a" : "b", text: plain(value) }));
	if (options.some(option => !option.text) || options[0].text === options[1].text) return;
	const prefix = trimmed.slice(0, trimmed.length - last.length + last.lastIndexOf(match[1])).trimEnd();
	return [
		...(prefix ? [{ kind: "markdown" as const, text: prefix }] : []),
		{ kind: "questions", questions: [{ id: "Q1", title: "", prompt: plain(match[1]), options }] },
	];
}

/** Numbered questions and explicit final offers render individually; other casual questions require a group. */
export function parseReplySegments(text: string): ReplySegment[] {
	const lines = text.split("\n");
	let fence: { char: string; length: number } | undefined;
	const eligible = lines.map(line => {
		const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
		if (marker) {
			if (!fence) fence = { char: marker[0], length: marker.length };
			else if (marker[0] === fence.char && marker.length >= fence.length && line.trim() === marker) fence = undefined;
			return false;
		}
		return !fence && QUESTION.test(line);
	});
	const hasNumberedQuestion = lines.some((line, index) => eligible[index] && /^\s*\*{0,2}Q\d+[a-z]?\b/.test(line.replace(QUESTION, "")));
	if (eligible.filter(Boolean).length < 2 && !hasNumberedQuestion) return trailingOffer(text) ?? [{ kind: "markdown", text }];
	const segments: ReplySegment[] = [];
	let markdown: string[] = [];
	let questions: QuestionCard[] = [];
	const flushMarkdown = () => { if (markdown.join("\n").trim()) segments.push({ kind: "markdown", text: markdown.join("\n") }); markdown = []; };
	const flushQuestions = () => { if (questions.length) segments.push({ kind: "questions", questions }); questions = []; };
	for (let i = 0; i < lines.length; i++) {
		if (!eligible[i]) {
			// Blank lines between questions do not end the run; prose and rules do.
			if (questions.length && !lines[i].trim()) continue;
			flushQuestions();
			markdown.push(lines[i]);
			continue;
		}
		flushMarkdown();
		const head = parseHead(lines[i], questions.length);
		const body: string[] = [head.prompt];
		const recommendation: string[] = [];
		const notes: string[] = [];
		while (i + 1 < lines.length && !eligible[i + 1] && !/^\s*(?:#{1,6}\s|-{3,}\s*$|`{3,}|~{3,})/.test(lines[i + 1])) {
			const next = lines[++i];
			if (NOTE.test(next)) notes.push(next.match(NOTE)![1]);
			else if (RECOMMEND.test(next)) recommendation.push(next.replace(RECOMMEND, ""));
			else if (recommendation.length) { if (!next.trim()) { if (NOTE.test(lines[i + 1] ?? "")) continue; break; } recommendation.push(next); }
			else body.push(next);
		}
		const listOptions: QuestionOption[] = [];
		const promptLines: string[] = [];
		for (const line of body) {
			const listed = LIST_OPTION.exec(plain(line));
			if (listed) listOptions.push({ key: (listed[1] ?? listed[2] ?? listed[3]!).toLowerCase(), text: plain(listed[4].trim()) });
			else promptLines.push(line);
		}
		const { prompt, options } = listOptions.length >= 2
			? { prompt: promptLines.join(" ").replace(/\s+/g, " ").trim(), options: listOptions }
			: parseOptions(body.join(" ").replace(/\s+/g, " ").trim());
		questions.push({ id: head.id, title: head.title, prompt: plain(prompt), ...(notes.length ? { note: plain(notes.join(" ")) } : {}), options: applyRecommendation(options, recommendation.join(" ")) });
	}
	flushQuestions();
	flushMarkdown();
	return segments;
}

/** Default choice per question: the recommended option, if any. */
export function recommendedAnswers(questions: readonly QuestionCard[]): Record<string, number> {
	const answers: Record<string, number> = {};
	for (const question of questions) {
		const index = question.options.findIndex(option => option.recommended);
		if (index >= 0) answers[question.id] = index;
	}
	return answers;
}

/** A question counts as answered by a listed option, or by "其他" once it has text. */
export function isAnswered(question: QuestionCard, answers: Record<string, number>, custom: Record<string, string>): boolean {
	const index = answers[question.id];
	return index === OTHER_ANSWER ? !!custom[question.id]?.trim() : !!question.options[index];
}

/** Reply text sent back, one line per answered question; the composer text follows as a note. */
export function composeAnswers(questions: readonly QuestionCard[], answers: Record<string, number>, note = "", custom: Record<string, string> = {}): string {
	const lines = questions.flatMap(question => {
		const label = `${question.id}${question.title ? ` ${question.title}` : ""}`;
		if (answers[question.id] === OTHER_ANSWER) {
			const text = custom[question.id]?.trim().replace(/\s*\n\s*/g, " ");
			return text ? [`${label}：其他 · ${text}`] : [];
		}
		const option = question.options[answers[question.id]];
		return option ? [`${label}：${option.key ? `(${option.key}) ` : ""}${option.text}`] : [];
	});
	return [lines.join("\n"), note.trim()].filter(Boolean).join("\n\n");
}
