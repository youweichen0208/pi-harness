import { useT } from "../i18n";
import { OTHER_ANSWER, recommendedAnswers, type QuestionCard } from "../question-cards";
import { answersFor, choose, customFor, selectOther, useQuestionAnswers, writeOther } from "../question-answers";

/** 4a: one card per question; options are rows, the recommended one is preselected with its reason,
 * and a final "其他" row takes a written answer instead. */
export function QuestionCards({ questions, answerKey }: { questions: QuestionCard[]; answerKey?: string; conversationId?: string }) {
	const t = useT();
	const shared = useQuestionAnswers();
	const live = !!answerKey && shared.active?.key === answerKey;
	const answers = live ? shared.answers : (answerKey && answersFor(answerKey)) || recommendedAnswers(questions);
	const custom = live ? shared.custom : (answerKey && customFor(answerKey)) || {};
	return <div className="question-cards">
		{questions.map(question => {
			const labelId = `${answerKey ?? "q"}-${question.id}`;
			const other = answers[question.id] === OTHER_ANSWER;
			return <section key={question.id} className="question-card" aria-labelledby={labelId}>
				<header>
					<span className="question-id">{question.id}</span>
					<div>
						{question.title && <h4 id={labelId}>{question.title}</h4>}
						{question.prompt && <p>{question.prompt}</p>}
					</div>
				</header>
				<div className="question-options" role="radiogroup" aria-label={question.title || question.id}>
					{question.options.map((option, index) => {
						const selected = answers[question.id] === index;
						return <button key={index} type="button" role="radio" aria-checked={selected} disabled={!live} className={`question-option${selected ? " selected" : ""}`} onClick={() => answerKey && choose(answerKey, question.id, index)}>
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
								onFocus={() => answerKey && !other && selectOther(answerKey, question.id)}
								onChange={event => answerKey && writeOther(answerKey, question.id, event.target.value)}
								onInput={event => { const field = event.currentTarget; field.style.height = "auto"; field.style.height = `${field.scrollHeight}px`; }} />
						</span>
					</div>
				</div>
				{question.note && <aside className="question-note">{question.note}</aside>}
			</section>;
		})}
	</div>;
}
