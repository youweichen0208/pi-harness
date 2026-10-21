import { useCallback, useEffect, useRef, useState } from "react";
import { FiPlay, FiSquare } from "react-icons/fi";
import { useT } from "../i18n";
import { usePlaygroundHost } from "../playground-context";
import { runKey, startRun, stopRun, usePlaygroundRun } from "../playground-run-store";
import { withToken } from "../auth-token";
import type { PlaygroundScratch as ScratchDoc } from "../types";
import { PlaygroundResult } from "./PlaygroundRun";

/**
 * The left-panel Playground page: a minimal Java scratchpad between 对话 and 小记.
 *
 * One draft per install, persisted server-side (`/api/playground/scratch`) so it
 * is still there next time. The page itself opens regardless of the execution
 * switch — writing code is not running it — but the Run control explains itself
 * when the switch is off or no JDK is present, same as every other entry.
 *
 * The Run reuses the app-wide run store, so leaving and re-entering the page
 * keeps a running Run alive; a page reload still clears it, as everywhere.
 */

/** Seeded once, on a fresh install that has never saved a draft. */
const TEMPLATE = `public class Main {
	public static void main(String[] args) {
		System.out.println("Hello, Playground");
	}
}`;

export function PlaygroundScratch() {
	const t = useT();
	const { status } = usePlaygroundHost();
	// `null` while loading: an empty string is a legitimate (cleared) draft.
	const [content, setContent] = useState<string | null>(null);
	const [saveFailed, setSaveFailed] = useState(false);
	const [lastRun, setLastRun] = useState<{ code: string; key: string } | null>(null);
	const run = usePlaygroundRun(lastRun?.key ?? "");
	const running = run.phase === "running";
	const saveTimer = useRef<number | undefined>(undefined);
	const latest = useRef("");
	latest.current = content ?? "";

	const save = useCallback(async (text: string): Promise<void> => {
		try {
			const response = await fetch(withToken("/api/playground/scratch"), {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content: text }),
			});
			if (!response.ok) throw new Error(String(response.status));
			setSaveFailed(false);
		} catch {
			setSaveFailed(true);
		}
	}, []);

	// Load once on open. A never-saved draft (updatedAt 0) seeds the template so
	// the first visit lands on a runnable program rather than a blank page.
	useEffect(() => {
		let cancelled = false;
		void (async () => {
			try {
				const response = await fetch(withToken("/api/playground/scratch"));
				if (!response.ok) throw new Error(String(response.status));
				const doc = await response.json() as ScratchDoc;
				if (cancelled) return;
				setContent(doc.updatedAt === 0 && !doc.content ? TEMPLATE : doc.content);
			} catch {
				if (!cancelled) setContent(TEMPLATE);
			}
		})();
		return () => { cancelled = true; };
	}, []);

	// Debounced autosave, and a flush when the page goes away.
	useEffect(() => {
		if (content === null) return;
		window.clearTimeout(saveTimer.current);
		saveTimer.current = window.setTimeout(() => { void save(content); }, 600);
		return () => { window.clearTimeout(saveTimer.current); };
	}, [content, save]);
	useEffect(() => () => { void save(latest.current); }, [save]);

	const startScratchRun = useCallback((code: string) => {
		const key = runKey("scratch", code);
		setLastRun({ code, key });
		void startRun(key, code);
	}, []);

	const reason = !status
		? t("playgroundChecking")
		: status.locked
			? t("playgroundLocked")
			: !status.enabled
				? t("playgroundDisabled")
				: !status.jdk.available
					? [t("playgroundNoJdk"), status.jdk.reason].filter(Boolean).join(" — ")
					: "";

	return <div className="scratch-page">
		<header className="scratch-head">
			<h2>Playground</h2>
			{running ? (
				<button type="button" className="btn" onClick={() => lastRun && stopRun(lastRun.key)}>
					<FiSquare aria-hidden="true" /><span>{t("playgroundStop")}</span>
				</button>
			) : (
				<button
					type="button"
					className="btn primary"
					disabled={!!reason || content === null || !content.trim()}
					title={reason || `${t("playgroundRun")} (⌘↵)`}
					onClick={() => startScratchRun(latest.current)}
				>
					<FiPlay aria-hidden="true" /><span>{t(lastRun ? "playgroundRerun" : "playgroundRun")}</span>
				</button>
			)}
			{saveFailed && <span className="scratch-save-error" role="alert">{t("fileSaveFailed")}</span>}
		</header>
		<textarea
			className="scratch-editor"
			value={content ?? ""}
			placeholder={t("playgroundScratchPlaceholder")}
			spellCheck={false}
			aria-label="Java"
			onChange={event => setContent(event.target.value)}
			onKeyDown={event => {
				if (event.key === "Tab" && !event.shiftKey && !event.nativeEvent.isComposing) {
					event.preventDefault();
					const target = event.currentTarget;
					const { selectionStart: start, selectionEnd: end } = target;
					setContent(value => (value ?? "").slice(0, start) + "\t" + (value ?? "").slice(end));
					// The value update is async; queue the caret restore.
					requestAnimationFrame(() => { target.selectionStart = target.selectionEnd = start + 1; });
				}
				// ⌘/Ctrl+Enter runs from the keyboard, like every other scratchpad.
				if ((event.metaKey || event.ctrlKey) && event.key === "Enter" && !reason && latest.current.trim()) {
					event.preventDefault();
					startScratchRun(latest.current);
				}
			}}
		/>
		{lastRun && <PlaygroundResult runKey={lastRun.key} stale={latest.current !== lastRun.code} />}
	</div>;
}
