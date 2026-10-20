import { Component, type ReactNode } from "react";
import { useT } from "../i18n";

class ViewBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
	state = { failed: false };
	static getDerivedStateFromError() { return { failed: true }; }
	render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

/** A stale lazy chunk must not unmount the chat or its unsent draft. */
export function TerminalViewBoundary({ children, onBack }: { children: ReactNode; onBack: () => void }) {
	const t = useT();
	return <ViewBoundary fallback={<div className="term-empty terminal-load-error" role="alert">
		<h2 className="term-empty-title">{t("terminalLoadFailed")}</h2>
		<p className="term-empty-sub">{t("terminalLoadFailedHint")}</p>
		<div className="terminal-load-actions">
			<button className="btn" onClick={onBack}>{t("terminalBackToChat")}</button>
			<button className="btn" onClick={() => window.location.reload()}>{t("terminalReloadPage")}</button>
		</div>
	</div>}>{children}</ViewBoundary>;
}
