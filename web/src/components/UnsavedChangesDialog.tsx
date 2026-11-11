import { useT } from "../i18n";

/**
 * The unsaved-changes confirmation shared by Wiki navigation and the single-document
 * dialog. Pure UI: each host owns its own state machine and decides what each action does.
 * Callers render it inside their own modal container and keep focus handling.
 */
export function UnsavedChangesDialog({ title, hint, busy, saving, onCancel, onDiscard, onSave, dialogRef }: {
	title?: string;
	hint?: string;
	busy?: boolean;
	saving?: boolean;
	onCancel: () => void;
	onDiscard: () => void;
	onSave: () => void;
	dialogRef?: React.Ref<HTMLElement>;
}) {
	const t = useT();
	return <div className="wiki-modal-backdrop">
		<section ref={dialogRef} className="wiki-confirm" role="dialog" aria-modal="true" aria-label={title ?? t("wikiUnsaved")}>
			<h2>{title ?? t("wikiUnsaved")}</h2>
			<p>{hint ?? t("wikiUnsavedHint")}</p>
			<div>
				<button disabled={saving} onClick={onCancel}>{t("cancel")}</button>
				<button disabled={saving} onClick={onDiscard}>{t("wikiDiscard")}</button>
				<button disabled={busy} onClick={onSave}>{t("wikiSaveContinue")}</button>
			</div>
		</section>
	</div>;
}
