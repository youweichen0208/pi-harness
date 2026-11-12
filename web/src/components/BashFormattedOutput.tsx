import { useChatT } from "../i18n";
import { OutputColor } from "./OutputColor";
import { useMemo } from "react";
import { highlightLine } from "../hljs-lite";
import { alignOutputCode, SEARCH_PREVIEW_LIMIT, TEXT_PREVIEW_LIMIT, type OutputFormat } from "../bash-output-format";
import { Markdown } from "./Markdown";

function Code({ text, language }: { text: string; language: string | null }) {
	const html = useMemo(() => highlightLine(alignOutputCode(text), language), [text, language]);
	return <pre className="bash-syntax" dangerouslySetInnerHTML={{ __html: html }} />;
}
export function BashFormattedOutput({ format, all }: { format: OutputFormat; all: boolean }) {
	const t = useChatT();
	if (format.kind === "terminal") return null;
	const groups: { path: string; records: Extract<OutputFormat, { kind: "search" }>["records"] }[] = [];
	if (format.kind === "search" || format.kind === "mixed") {
		for (const record of all ? format.records : format.records.slice(0, SEARCH_PREVIEW_LIMIT)) {
			const last = groups.at(-1);
			if (last && last.path === record.path) last.records.push(record);
			else groups.push({ path: record.path, records: [record] });
		}
	}
	return <div className="bash-formatted-output">
		{format.kind === "mixed" && <><section className="bash-mixed-log"><div className="bash-search-location">{t("bashExecutionLog")}</div><pre>{format.log.split("\n").slice(0, all ? undefined : SEARCH_PREVIEW_LIMIT).map((line, i) => <span key={i}><OutputColor text={line} />{"\n"}</span>)}</pre></section><div className="bash-search-location">{t("bashCodeMatches")}</div></>}
		{format.kind === "search" || format.kind === "mixed" ? groups.map((group, i) => <section className="bash-search-file" key={i}>
			{group.path && <div className="bash-search-location">{group.path}</div>}
			{group.records.map((record, index) => <div className={`bash-search-result${record.markdown ? " prose" : ""}`} key={index}>
				{record.markdown ? <Markdown text={record.text} /> : <Code text={record.text} language={record.language} />}
			</div>)}
		</section>) : format.kind === "markdown" ? <Markdown text={all ? format.text : format.text.split("\n").slice(0, TEXT_PREVIEW_LIMIT).join("\n")} /> : <Code text={all ? format.text : format.text.split("\n").slice(0, TEXT_PREVIEW_LIMIT).join("\n")} language={format.language} />}
	</div>;
}
