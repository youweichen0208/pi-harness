import { useEffect, useRef, useState } from "react";
import type { ClientMessage, ServerMessage, UiAskAnswer, UiAskQuestion } from "../types";
import { useT } from "../i18n";

interface DialogProps {
	dialog: Extract<ServerMessage, { type: "dialog" }>;
	send: (msg: ClientMessage) => boolean;
}

/**
 * Bridges extension `ui.select/confirm/input` calls to an inline panel
 * rendered above the chat input (non-modal — the conversation stays visible).
 * Resolves via dialog_response; cancel/Esc resolves with null.
 */
export function Dialog({ dialog, send }: DialogProps) {
	const t = useT();
	const rootRef = useRef<HTMLDivElement>(null);
	const [inputValue, setInputValue] = useState("");
	const [sel, setSel] = useState(0);

	const respond = (value: string | boolean | UiAskAnswer[] | null) => {
		send({ type: "dialog_response", conversationId: dialog.conversationId, id: dialog.id, value });
	};

	useEffect(() => {
		setInputValue(dialog.kind === "editor" ? String(dialog.args[0] ?? "") : "");
		setSel(dialog.initialIndex ?? 0);
		if (dialog.kind === "select") rootRef.current?.querySelector<HTMLButtonElement>(`[data-option-index="${dialog.initialIndex ?? 0}"]`)?.focus();
		const onKey = (e: KeyboardEvent) => {
			if (e.defaultPrevented || (e.target instanceof Element && e.target.closest('[role="dialog"]') && !rootRef.current?.contains(e.target))) return;
			if (e.key === "Escape") respond(null);
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [dialog.id]);

	const options = Array.isArray(dialog.args[0])
		? (dialog.args[0] as string[])
		: [];
	const message =
		typeof dialog.args[0] === "string" ? (dialog.args[0] as string) : "";

	return (
		<div ref={rootRef} className="dialog-inline" role="region" aria-label={dialog.title || t("pluginRequest")} data-dialog-kind={dialog.kind}>
			<div className="dialog-head">
				<span className="dialog-badge">{t("pluginRequest")}</span>
				{dialog.title && dialog.title !== t("pluginRequest") && (
					<span className="dialog-title">{dialog.title}</span>
				)}
				<button
					type="button"
					className="dialog-dismiss"
					title={t("cancel")}
					onClick={() => respond(null)}
				>
					✕
				</button>
			</div>

			{dialog.kind === "ask" && <AskQuestions key={dialog.id} questions={dialog.questions ?? []} timed={dialog.timeoutMs !== undefined} respond={respond} />}

			{dialog.kind === "select" && (
				<div className="dialog-options" role={dialog.selectionMarker === "radio" ? "radiogroup" : "group"} aria-label={dialog.title || t("pluginRequest")} onKeyDown={event => {
					const next = event.key === "ArrowDown" ? (sel + 1) % options.length : event.key === "ArrowUp" ? (sel - 1 + options.length) % options.length : event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : undefined;
					if (next !== undefined && options.length) { event.preventDefault(); rootRef.current?.querySelector<HTMLButtonElement>(`[data-option-index="${next}"]`)?.focus(); }
				}}>
					{options.map((opt, i) => (
						<button
							type="button"
							key={i}
							data-option-index={i}
							aria-label={opt}
							tabIndex={i === sel ? 0 : -1}
							role={i < (dialog.markableCount ?? options.length) ? dialog.selectionMarker : undefined}
							aria-checked={i < (dialog.markableCount ?? options.length) && dialog.selectionMarker ? dialog.selectionMarker === "checkbox" ? (dialog.checkedIndices ?? []).includes(i) : i === sel : undefined}
							aria-describedby={dialog.optionDetails?.[i]?.description ? `dialog-${dialog.id}-option-${i}` : undefined}
							className={`dialog-option ${i === sel ? "sel" : ""}`}
							onFocus={() => setSel(i)}
							onClick={() => respond(opt)}
						>
							{dialog.selectionMarker && i < (dialog.markableCount ?? options.length) && <span className="dialog-selection-marker" aria-hidden="true">{dialog.selectionMarker === "checkbox" ? (dialog.checkedIndices ?? []).includes(i) ? "☑" : "☐" : i === sel ? "◉" : "○"}</span>}{opt}
							{dialog.optionDetails?.[i]?.description && <span id={`dialog-${dialog.id}-option-${i}`} className="dialog-ask-description">{dialog.optionDetails[i].description}</span>}
						</button>
					))}
					{options.length === 0 && (
						<div className="dialog-hint">{t("noOptions")}</div>
					)}
				</div>
			)}

			{dialog.kind === "confirm" && (
				<div className="dialog-body">
					<p>{message}</p>
					<div className="dialog-actions">
						<button
							type="button"
							className="btn"
							onClick={() => respond(false)}
						>
							{t("cancel")}
						</button>
						<button
							type="button"
							className="btn primary"
							onClick={() => respond(true)}
						>
							{t("ok")}
						</button>
					</div>
				</div>
			)}

			{(dialog.kind === "input" || dialog.kind === "editor") && (
				<div className="dialog-body">
					{dialog.kind === "editor" ? <textarea aria-label={dialog.title || t("inputPlaceholder")} className="dialog-input" rows={8} value={inputValue} autoFocus onChange={e => setInputValue(e.target.value)} /> : <input
						className="dialog-input"
						type={dialog.secret ? "password" : "text"}
						aria-label={dialog.title || t("inputPlaceholder")}
						value={inputValue}
						placeholder={message || t("inputPlaceholder")}
						autoFocus
						onChange={(e) => setInputValue(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.nativeEvent.isComposing) {
								respond(inputValue);
							}
						}}
					/>}
					<div className="dialog-actions">
						<button
							type="button"
							className="btn"
							onClick={() => respond(null)}
						>
							{t("cancel")}
						</button>
						<button
							type="button"
							className="btn primary"
							onClick={() => respond(inputValue)}
						>
							{t("ok")}
						</button>
					</div>
				</div>
			)}
		</div>
	);
}

/** The SDK owns question order, cancellation and timeouts; this form only collects answers. */
function AskQuestions({ questions, timed, respond }: { questions: UiAskQuestion[]; timed: boolean; respond(value: UiAskAnswer[] | null): void }) {
	const t = useT();
	const [answers, setAnswers] = useState<UiAskAnswer[]>(() => questions.map(question => ({ id: question.id, selectedOptions: [] })));
	const update = (index: number, change: (answer: UiAskAnswer) => UiAskAnswer) => setAnswers(current => current.map((answer, i) => i === index ? change(answer) : answer));
	return <form className="dialog-ask" onSubmit={event => { event.preventDefault(); respond(answers); }}>
		{timed && <p className="dialog-hint" role="status">{t("ompAskTimeout")}</p>}
		{questions.map((question, index) => <fieldset className="dialog-ask-question" key={index}>
			<legend>{question.header && <strong>{question.header} · </strong>}{question.question}</legend>
			{question.multi && <p className="dialog-hint">{t("ompAskMultiple")}</p>}
			<div className="dialog-options">{question.options.map((option, optionIndex) => <label className="dialog-option dialog-ask-option" key={optionIndex}>
				<input type={question.multi ? "checkbox" : "radio"} name={`ask-${index}`} checked={answers[index].selectedOptions.includes(option.label)} onChange={() => update(index, answer => ({ ...answer,
					selectedOptions: question.multi ? answer.selectedOptions.includes(option.label) ? answer.selectedOptions.filter(label => label !== option.label) : [...answer.selectedOptions, option.label] : [option.label],
					...(!question.multi ? { customInput: "" } : {}),
				}))} />
				<span>{option.label}{question.recommended === optionIndex && <small className="dialog-ask-recommended">{t("ompAskRecommended")}</small>}
					{option.description && <span className="dialog-ask-description">{option.description}</span>}
					{option.preview && <pre className="dialog-ask-preview">{option.preview}</pre>}
				</span>
			</label>)}</div>
			<label className="dialog-ask-other">{t("ompAskCustom")}
				<textarea className="dialog-input" rows={2} value={answers[index].customInput ?? ""} onChange={event => update(index, answer => ({ ...answer, customInput: event.target.value, ...(!question.multi && event.target.value.trim() ? { selectedOptions: [] } : {}) }))} />
			</label>
		</fieldset>)}
		<p className="dialog-hint">{t("ompAskUnanswered")}</p>
		<div className="dialog-actions">
			<button type="button" className="btn" onClick={() => respond(null)}>{t("cancel")}</button>
			<button type="submit" className="btn primary">{t("ok")}</button>
		</div>
	</form>;
}
