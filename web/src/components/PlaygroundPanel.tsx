import { useEffect, useState } from "react";
import { useT } from "../i18n";
import type { PlaygroundConfigPatch, PlaygroundStatus } from "../types";

export interface PlaygroundControls {
	status: PlaygroundStatus | null;
	configure: (patch: PlaygroundConfigPatch) => Promise<string>;
	redetect: () => Promise<void>;
}

/**
 * The settings surface for code execution.
 *
 * Deliberately blunt: this switch grants arbitrary code execution on the host,
 * so the panel says so in plain language rather than burying it, and every
 * unavailable state explains itself instead of rendering a dead control.
 */
export function PlaygroundPanel({ playground }: { playground: PlaygroundControls }) {
	const t = useT();
	const { status, configure, redetect } = playground;
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	const [probing, setProbing] = useState(false);
	// The timeout is edited as a number but must not write on every keystroke.
	const [timeout, setTimeoutValue] = useState("");
	useEffect(() => { if (status) setTimeoutValue(String(Math.round(status.limits.timeoutMs / 1000))); }, [status]);

	if (!status) return <p>{t("loading")}</p>;
	const locked = status.locked;

	const write = async (patch: PlaygroundConfigPatch) => {
		setBusy(true);
		setError("");
		const message = await configure(patch);
		if (message) setError(message);
		setBusy(false);
	};
	const toggle = (enabled: boolean) => {
		// Enabling is the dangerous direction, so it is the one that asks.
		if (enabled && !window.confirm(t("playgroundEnableWarning"))) return;
		void write({ enabled });
	};
	const commitTimeout = () => {
		const seconds = Number(timeout);
		if (!Number.isFinite(seconds)) {
			setTimeoutValue(String(Math.round(status.limits.timeoutMs / 1000)));
			return;
		}
		void write({ timeoutMs: Math.round(seconds * 1000) });
	};

	return <div className="playground-settings">
		<p className="playground-warning" role="note">{t("playgroundNotASandbox")}</p>

		<label className="playground-toggle">
			<input type="checkbox" checked={status.enabled} disabled={locked || busy} onChange={event => toggle(event.target.checked)} />
			<span>{t("playgroundEnabled")}</span>
		</label>
		{locked && <p className="playground-hint" role="status">{t("playgroundLocked")}</p>}

		<label className="playground-field">
			<span>{t("playgroundTimeout")}</span>
			<input
				type="number" min={1} max={60} value={timeout} disabled={locked || busy}
				onChange={event => setTimeoutValue(event.target.value)}
				onBlur={commitTimeout}
				onKeyDown={event => { if (event.key === "Enter") commitTimeout(); }}
			/>
		</label>

		<div className="playground-python">
			<span className="playground-python-label">{t("playgroundPython")}</span>
			<span role="status" title={status.python.path}>
				{status.python.available
					? t("playgroundPythonFound", { version: status.python.version ?? "" })
					: [t("playgroundNoPython"), status.python.reason].filter(Boolean).join(" — ")}
			</span>
			<button type="button" className="btn" disabled={probing} onClick={() => { setProbing(true); void redetect().finally(() => setProbing(false)); }}>
				{t("playgroundRedetect")}
			</button>
		</div>

		{error && <p className="playground-error" role="alert">{t("playgroundSaveFailed", { error })}</p>}
	</div>;
}
