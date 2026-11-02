import { useState } from "react";
import { FiChevronRight } from "react-icons/fi";
import { useT } from "../i18n";
import { OTHER_ANSWER, recommendedAnswers, type QuestionCard } from "../question-cards";
import { answersFor, choose, expandQuestion, customFor, selectOther, useQuestionAnswers, writeOther } from "../question-answers";

/** 4a: one card per question; options are rows, the recommended one is preselected with its reason,
 * and a final "其他" row takes a written answer instead. */
export function QuestionCards({ questions, answerKey }: { questions: QuestionCard[]; answerKey?: string; conversationId?: string }) {
	const t = useT();
	const shared = useQuestionAnswers();
	const live = !!answerKey && shared.active?.key === answerKey;
	const answers = live ? shared.answers : (answerKey && answersFor(answerKey)) || recommendedAnswers(questions);
	const [historyOpen, setHistoryOpen] = useState(questions[0]?.id);
	const expandedId = live ? shared.expandedQuestionId : historyOpen;
	const advance = (id: string, focus = false) => {
		if (!answerKey || !live) return;
		const all = shared.active!.questions;
		const next = all[all.findIndex(question => question.id === id) + 1];
		if (!next) return;
		expandQuestion(answerKey, next.id);
		if (focus) requestAnimationFrame(() => document.getElementById(`${answerKey}-${next.id}-toggle`)?.focus());
	};
	const custom = live ? shared.custom : (answerKey && customFor(answerKey)) || {};
	return <div className="question-cards">
		{questions.map(question => {
			const labelId = `${answerKey ?? "q"}-${question.id}`;
			const open = expandedId === question.id;
			const other = answers[question.id] === OTHER_ANSWER;
			return <section key={question.id} className={`question-card${open ? " expanded" : " collapsed"}`} aria-labelledby={labelId}>
				<header>
					<button type="button" id={`${labelId}-toggle`} className="question-heading-toggle" aria-expanded={open} aria-controls={`${labelId}-body`} onClick={() => live && answerKey ? expandQuestion(answerKey, open ? "" : question.id) : setHistoryOpen(open ? "" : question.id)}>
						<span className="question-id">{question.id}</span>
						<span id={labelId} className="question-heading-title">{question.title || question.prompt || question.id}</span>
						<FiChevronRight className={open ? "open" : ""} aria-hidden="true" />
					</button>
				</header>
				<div id={`${labelId}-body`} className="question-body" hidden={!open}>
				{question.prompt && question.title && <p className="question-prompt">{question.prompt}</p>}
				<div className="question-options" role="radiogroup" aria-label={question.title || question.id}>
					{question.options.map((option, index) => {
						const selected = answers[question.id] === index;
						return <button key={index} type="button" role="radio" aria-checked={selected} disabled={!live} className={`question-option${option.recommended ? " recommended" : ""}${selected ? " selected" : ""}`} onClick={() => { if (!answerKey) return; choose(answerKey, question.id, index); if (!selected) advance(question.id, true); }}>
							<span className="question-radio" aria-hidden="true" />
							<span className="question-option-body">
								<span className="question-option-text">{option.key && <b>{option.key}.</b>}{option.text}{option.recommended && <em>{t("questionRecommended")}</em>}</span>
								{option.recommended && option.reason && <small>{option.reason}</small>}
							</span>
						</button>;
					})}
					<div className={`question-option question-other${other ? " selected" : ""}`}>
						<button type="button" role="radio" aria-checked={other} disabled={!live} aria-label={t("questionOther")} className="question-other-radio" onClick={() => answerKey && selectOther(answerKey, question.id)}>
							<span className="question-radio" aria-hidden="true" />
						</button>
						<span className="question-option-body">
							<span className="question-option-text">{t("questionOther")}</span>
							<textarea rows={1} value={custom[question.id] ?? ""} disabled={!live} aria-label={`${question.id} ${t("questionOther")}`} placeholder={t("questionOtherPlaceholder")}
								onBlur={event => { if (event.relatedTarget instanceof Element && event.relatedTarget.closest(".question-card")) return; if ((custom[question.id] ?? "").trim()) advance(question.id); }}
								onFocus={() => answerKey && !other && selectOther(answerKey, question.id)}
								onChange={event => answerKey && writeOther(answerKey, question.id, event.target.value)}
								onInput={event => { const field = event.currentTarget; field.style.height = "auto"; field.style.height = `${field.scrollHeight}px`; }} />
						</span>
					</div>
				</div>
				{question.note && <aside className="question-note">{question.note}</aside>}
				</div>
			</section>;
		})}
	</div>;
}
