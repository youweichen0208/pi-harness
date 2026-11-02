import type { parseAnswerSummary } from "../answer-history";
import { useT } from "../i18n";
import { preserveUserTree } from "../user-message-presentation";
import { Markdown } from "./Markdown";

/** One user reply stays one card; notes remain verbatim Markdown below its answers. */
export function AnswerSummary({ summary }: { summary: NonNullable<ReturnType<typeof parseAnswerSummary>> }) {
	const t = useT();
	return <>
		<div className="answer-summary">
			{summary.items.map(item => <div className="answer-summary-item" key={item.id}>
				<div className="answer-summary-question"><b>{item.id}</b><span>{item.title}</span></div>
				<div className="answer-summary-answer"><span aria-hidden="true">→</span><span>{item.answer}</span></div>
			</div>)}
			<span className="answer-summary-count">{t("answersCompleted", { n: summary.items.length })}</span>
		</div>
		{summary.note && <Markdown text={preserveUserTree(summary.note)} fileLinks />}
	</>;
}
