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
	const id = /\*{0,2}(Q\d+)\*{0,2}/.exec(body)?.[1] ?? `Q${index + 1}`;
	const rest = body.replace(/^\*{0,2}Q\d+\*{0,2}\s*[-–—:：.]?\s*/, "");
	const titled = /^\*\*([^*]+)\*\*\s*[:：]?\s*(.*)$/.exec(rest);
	return titled ? { id, title: plain(titled[1]), prompt: titled[2] } : { id, title: "", prompt: rest };
}

/** Split `(a) x;(b) y;(c) z。trailing` into options; text before (a) and after the last option's sentence stays prompt. */
function parseOptions(text: string) {
	const parts = text.split(/[(（]([a-h])[)）]\s*/);
	if (parts.length < 5) return { prompt: text, options: [] as QuestionOption[] };
	const options: QuestionOption[] = [];
	let trailing = "";
	for (let i = 1; i < parts.length; i += 2) {
		let option = parts[i + 1].trim().replace(/[;；]\s*$/, "");
		if (i + 2 >= parts.length) {
			const end = option.search(/[。？?](?=.)/);
			if (end >= 0) { trailing = option.slice(end + 1).trim(); option = option.slice(0, end); }
		}
		options.push({ key: parts[i], text: plain(option.replace(/[。;；]\s*$/, "")) });
	}
	return { prompt: [parts[0].trim(), trailing].filter(Boolean).join(" "), options };
}

function applyRecommendation(options: QuestionOption[], text: string): QuestionOption[] {
	const body = plain(text).replace(/^推荐\s*[:：]?\s*/, "").replace(/^Recommend(?:ed|ation)?\s*[:：]?\s*/i, "");
	const keyed = /^[(（]([a-h])[)）]\s*(.*)$/.exec(body);
	const reason = (keyed ? keyed[2] : "").replace(/^[。.,，:：;；\s]+/, "");
	const picked = keyed && options.find(option => option.key === keyed[1]);
	if (picked) { picked.recommended = true; if (reason) picked.reason = reason; return options; }
	if (options.length) return options;
	// Open question: the recommendation is the preselected option; the card's "其他" row covers everything else.
	const cut = body.search(/[。：:；;]/);
	const answer = (cut > 0 ? body.slice(0, cut) : body).trim();
	const why = cut > 0 ? body.slice(cut + 1).trim() : "";
	return answer ? [{ text: answer, recommended: true, ...(why ? { reason: why } : {}) }] : [];
}

/** Returns a single markdown segment when the reply holds fewer than two questions. */
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
	if (eligible.filter(Boolean).length < 2) return [{ kind: "markdown", text }];
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
		const { prompt, options } = parseOptions(body.join(" ").replace(/\s+/g, " ").trim());
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
