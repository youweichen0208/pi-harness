import { isLikelyErrorLine, searchSourceNumberParts } from "../bash-presentation";

/** Small, conservative accents; React escapes every part and preserves the source text. */
export function OutputColor({ text, searchNumbers = false }: { text: string; searchNumbers?: boolean }) {
	const source = searchNumbers ? searchSourceNumberParts(text) : null;
	if (source) return <>{source.prefix}<OutputColor text={source.rest.trimStart()} /></>;
	if (isLikelyErrorLine(text)) return <span className="bash-color-delete">{text}</span>;
	if (/^\s*(?:={2,}|─{2,}|━{2,})\s*\S.*?(?:={2,}|─{2,}|━{2,})\s*$/.test(text)) return <span className="bash-output-section">{text}</span>;
	if (/^\s*(?:warning|warn|警告)(?:\b|[：:])/i.test(text)) return <span className="bash-output-warning">{text}</span>;
	const listing = /^(\s*[bcdlps-][rwxStTs-]{9}[@+.]?)(\s+\d+\s+\S+\s+\S+\s+\d+\s+\S+\s+\d+\s+[\d:]+\s+)(.+)$/.exec(text);
	if (listing) return <><span className="bash-output-meta">{listing[1]}{listing[2]}</span><span className="bash-output-filename">{listing[3]}</span></>;
	const field = /^(\s*)([\p{L}_][\p{L}\p{N}_ .-]{0,60}?)(\s+=\s+|[：:]\s+)(.*)$/u.exec(text);
	if (field) return <>{field[1]}<span className="bash-output-key">{field[2]}</span>{field[3]}<span className={/^(?:-?\d+(?:\.\d+)?|true|false|null|None)$/.test(field[4]) ? "bash-output-value" : undefined}>{field[4]}</span></>;
	const stat = /^(\s*.+?)(\s+\|\s+\d+\s+)([+\-]+)(\s*)$/.exec(text);
	if (stat) return <>{stat[1]}{stat[2]}{stat[3].split(/(\++|-+)/).filter(Boolean).map((part, i) => <span key={i} className={part[0] === "+" ? "bash-color-add" : "bash-color-delete"}>{part}</span>)}{stat[4]}</>;
	return <>{text.split(/(\b\d+ insertions?\(\+\)|\b\d+ deletions?\(-\)|\b(?:PASS|passed|SUCCESS)\b)/g).map((part, i) => <span key={i} className={/^\d+ insertions?/.test(part) || /^(PASS|passed|SUCCESS)$/.test(part) ? "bash-color-add" : /^\d+ deletions?/.test(part) ? "bash-color-delete" : undefined}>{part}</span>)}</>;
}
