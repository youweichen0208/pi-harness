import { BrandWordmark } from "./BrandWordmark";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiBookOpen, FiCornerDownLeft, FiGithub, FiGlobe, FiMaximize2, FiPlus, FiRefreshCw, FiSearch, FiSend, FiX } from "react-icons/fi";
import { desktopAPI, type BrowserState } from "../desktop";
import { useT } from "../i18n";

export function BrowserPanel({ owner, close }: { owner: string; close: () => void }) {
	const t = useT();
	const viewport = useRef<HTMLDivElement>(null);
	const [state, setState] = useState<BrowserState>({ tabs: [] });
	const [address, setAddress] = useState("");
	const [expanded, expand] = useState(false);
	const [error, setError] = useState("");
	const tab = state.tabs.find(tab => tab.id === state.active);
	const blank = !tab?.url || tab.url === "about:blank";
	const browser = desktopAPI!.browser!;
	function command(action: string, value?: unknown) {
		setError("");
		void browser(action, value).then(setState, e => setError(String(e.message)));
	}
	useLayoutEffect(() => {
		const unsubscribe = desktopAPI!.onBrowser!(setState);
		command("open", owner);
		let previous = "";
		const measure = () => {
			const host = viewport.current;
			if (!host) return;
			const r = host.getBoundingClientRect();
			const points = [
				[r.left + 1, r.top + 1],
				[r.right - 1, r.top + 1],
				[r.left + 1, r.bottom - 1],
				[r.right - 1, r.bottom - 1],
				[r.left + r.width / 2, r.top + r.height / 2],
			];
			const visible =
				r.width > 2 &&
				r.height > 2 &&
				points.every(([x, y]) => host.contains(document.elementFromPoint(x, y))) &&
				!document.querySelector('[role="dialog"]:not([hidden]),dialog[open],.modal-backdrop');
			const bounds = visible
				? { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) }
				: null;
			const key = JSON.stringify(bounds);
			if (key !== previous) {
				previous = key;
				void browser("bounds", bounds).catch(() => {});
			}
		};
		measure();
		const observer = new ResizeObserver(measure);
		if (viewport.current) observer.observe(viewport.current);
		const timer = window.setInterval(measure, 120);
		const resume = () => {
			if (!document.hidden) {
				command("open", owner);
				previous = "";
				measure();
			}
		};
		document.addEventListener("visibilitychange", resume);
		return () => {
			unsubscribe();
			observer.disconnect();
			clearInterval(timer);
			document.removeEventListener("visibilitychange", resume);
			void browser("hide").catch(() => {});
		};
	}, [browser, owner]);
	useEffect(() => {
		setAddress(blank ? "" : tab.url);
	}, [tab?.id, tab?.url, blank]);
	function navigate(input: string) {
		const raw = input.trim();
		if (!raw) return;
		command(
			"go",
			/^https?:\/\//i.test(raw)
				? raw
				: /^(localhost|[^\s/]+\.[^\s/]+)([:/]|$)/i.test(raw)
					? "https://" + raw
					: "https://www.google.com/search?q=" + encodeURIComponent(raw),
		);
	}
	return (
		<aside className={"embedded-browser" + (expanded ? " expanded" : "")} aria-label={t("embeddedBrowser")}>
			<div className="embedded-controls">
				<div className="embedded-toolbar">
					<div className="embedded-tabs">
						{state.tabs.map(item => (
							<div className={item.id === state.active ? "selected" : ""} key={item.id}>
								<button aria-pressed={item.id === state.active} onClick={() => command("select", item.id)}>
									<FiGlobe />
									{item.title || t("browserTab")}
								</button>
								<button aria-label={t("close") + " " + (item.title || t("browserTab"))} onClick={() => command("close", item.id)}>
									<FiX />
								</button>
							</div>
						))}
					</div>
					<button title={t("browserTab")} onClick={() => command("add")}>
						<FiPlus />
					</button>
					<button title={t("browserExpand")} onClick={() => expand(!expanded)}>
						<FiMaximize2 />
					</button>
					<button title={t("close")} onClick={close}>
						<FiX />
					</button>
				</div>
				<form
					className="embedded-toolbar"
					onSubmit={e => {
						e.preventDefault();
						navigate(address);
					}}
				>
					<button type="button" title={t("browserBack")} disabled={!tab?.back} onClick={() => command("back")}>
						<FiArrowLeft />
					</button>
					<button type="button" title={t("browserForward")} disabled={!tab?.forward} onClick={() => command("forward")}>
						<FiArrowRight />
					</button>
					<button type="button" title={t("browserReload")} disabled={blank} onClick={() => command("reload")}>
						<FiRefreshCw />
					</button>
					<input
						aria-label={t("browserAddress")}
						placeholder={t("browserAddress")}
						value={address}
						onFocus={e => e.target.select()}
						onChange={e => setAddress(e.target.value)}
					/>
				</form>
				{state.confirmation && <div className="browser-confirmation" role="group" aria-label={t("browserConfirmAction")}>
					<strong>{t("browserConfirmAction")}</strong>
					<span>{state.confirmation.site} · {state.confirmation.target}</span>
					{state.confirmation.purpose && <span>{state.confirmation.purpose}</span>}
					<div>{[false, true].map(accept => <button key={String(accept)} onClick={() =>
						command("answer", { id: state.confirmation!.id, accept })}>{t(accept ? "confirm" : "cancel")}</button>)}</div>
				</div>}
			</div>
			{error && <div role="alert">{error}</div>}
			<div ref={viewport} className="embedded-viewport">
				{blank && (
					<section className="browser-start" key={tab?.id}>
						<h2 aria-label="pi-harness"><img src="./brand-mark.svg" alt="" width="48" height="48" /><BrandWordmark /></h2>
						<form className="browser-start-search" role="search" onSubmit={event => {
							event.preventDefault();
							navigate(String(new FormData(event.currentTarget).get("query") ?? ""));
						}}>
							<FiSearch aria-hidden="true" />
							<input name="query" aria-label={t("browserStartQuery")} placeholder={t("browserStartQuery")} autoComplete="off" spellCheck={false} />
							<button type="submit" aria-label={t("browserGo")} title={t("browserGo")}><FiCornerDownLeft aria-hidden="true" /></button>
						</form>
						<div className="browser-shortcuts" role="group" aria-label={t("browserApps")}>
							{[
								{ name: t("browserFeishu"), url: "https://www.feishu.cn", Icon: FiSend },
								{ name: "GitHub", url: "https://github.com", Icon: FiGithub },
								{ name: "Notion", url: "https://www.notion.so", Icon: FiBookOpen },
							].map(({ name, url, Icon }) => (
								<button key={url} onClick={() => navigate(url)}>
									<span><Icon aria-hidden="true" /></span>{name}
								</button>
							))}
						</div>
					</section>
				)}
			</div>
		</aside>
	);
}
