import { Component, type ErrorInfo, type ReactNode } from "react";
import { useT } from "../i18n";

/**
 * Keeps one lazily-loaded feature from taking the whole app down.
 *
 * A dynamic `import()` that fails — a stale dev pre-bundle
 * (`504 Outdated Optimize Dep`), a chunk that disappeared after a rebuild, or a
 * flaky network — rejects inside Suspense, and without a boundary React unmounts
 * the entire tree, which the user experiences as a blank page. Catching it here
 * leaves the sidebar and the rest of the shell usable and offers a reload.
 *
 * Retrying is a full reload rather than a re-render: the failed module request is
 * cached by the browser for that document, so re-rendering would fail again.
 */
class Boundary extends Component<{ label: string; reloadLabel: string; children: ReactNode }, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		// Keep the stack in the console: the UI only makes sense to the user as
		// "this panel did not load", the cause belongs to whoever is debugging.
		console.error(`[${this.props.label}] failed to load`, error, info.componentStack);
	}

	render() {
		if (!this.state.failed) return this.props.children;
		return <div className="pane-error" role="alert">
			<p>{this.props.label}</p>
			<button type="button" className="btn" onClick={() => location.reload()}>{this.props.reloadLabel}</button>
		</div>;
	}
}

/** Boundary for one pane, with the localized copy it needs. */
export function PaneErrorBoundary({ name, children }: { name: string; children: ReactNode }) {
	const t = useT();
	return <Boundary label={t("paneLoadFailed").replace("{name}", name)} reloadLabel={t("paneLoadReload")}>{children}</Boundary>;
}
