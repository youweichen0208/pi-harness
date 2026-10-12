import { useEffect } from "react";
import { useT } from "../i18n";
import type { QuestionCard } from "../question-cards";
import { answersFor, choose, registerQuestions, useQuestionAnswers } from "../question-answers";
import { recommendedAnswers } from "../question-cards";

/** 4a: one card per question; options are rows, the recommended one is preselected with its reason. */
export function QuestionCards({ questions, answerKey, conversationId }: { questions: QuestionCard[]; answerKey?: string; conversationId?: string }) {
	const t = useT();
	const shared = useQuestionAnswers();
	useEffect(() => {
		if (!answerKey || !conversationId) return;
		return registerQuestions(answerKey, conversationId, questions);
	}, [answerKey, conversationId, questions]);
	const live = !!answerKey && shared.active?.key === answerKey;
	const answers = live ? shared.answers : (answerKey && answersFor(answerKey)) || recommendedAnswers(questions);
	return <div className="question-cards">
		{questions.map(question => <section key={question.id} className="question-card" aria-labelledby={`${answerKey ?? "q"}-${question.id}`}>
			<header>
				<span className="question-id">{question.id}</span>
				<div>
					{question.title && <h4 id={`${answerKey ?? "q"}-${question.id}`}>{question.title}</h4>}
					{question.prompt && <p>{question.prompt}</p>}
				</div>
			</header>
			{question.options.length > 0 && <div className="question-options" role="radiogroup" aria-label={question.title || question.id}>
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
			</div>}
		</section>)}
	</div>;
}
