import type { ScmFileEntry, SessionSummary } from "../types";
import { useT } from "../i18n";

interface HomeProps {
	cwd: string;
	branch: string;
	changed: ScmFileEntry[];
	notRepo: boolean;
	previous?: SessionSummary;
	onContinue: (path: string) => void;
}

/** The composer stays mounted between these two fragments. */
export function ConversationHome({ cwd, branch, changed, notRepo, previous, onContinue, suggestions = false }: HomeProps & { suggestions?: boolean }) {
	const t = useT();
	const project = cwd.replace(/[\\/]+$/, "").split(/[\\/]/).at(-1) || cwd;
	const fill = (text: string) => window.dispatchEvent(new CustomEvent("pi-web:append-prompt", { detail: { cwd, text } }));
	if (!suggestions) return <header className="conversation-home-heading">
		<h1>{t("homeProjectTitle", { name: project })}</h1>
		<p>{!notRepo && <>{branch && <span>{branch} · </span>}{t("homeChanges", { n: changed.length })}</>}{previous && <span> · {t("homeLastChat")} {new Date(previous.modified).toLocaleDateString()}</span>}{notRepo && !previous && cwd}</p>
	</header>;
	const directories = [...new Set(changed.map(file => file.path.includes("/") ? `${file.path.split("/")[0]}/` : file.path))].slice(0, 3).join(" · ");
	return <div className="conversation-home-suggestions">
		{previous ? <button type="button" onClick={() => onContinue(previous.path)}><small>{t("homeContinue")}</small><strong>{previous.name || previous.firstMessage || t("newChat")}</strong><span>{t("homeOpenConversation")}</span></button> : <button type="button" onClick={() => fill(t("ex.understand.prompt"))}><small>{t("homeExplore")}</small><strong>{t("ex.understand")}</strong><span>{project}</span></button>}
		{!notRepo && <button type="button" onClick={() => fill(t("homeReviewPrompt"))}><small>Git</small><strong>{t("homeReviewChanges", { n: changed.length })}</strong><span>{directories || t("homeCleanTree")}</span></button>}
		<button type="button" onClick={() => fill(t("homeTestPrompt"))}><small>{t("homeCheck")}</small><strong>{t("homeRunChecks")}</strong><span>{t("homeChecksHint")}</span></button>
	</div>;
}
