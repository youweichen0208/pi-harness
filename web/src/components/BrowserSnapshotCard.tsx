import { useId, useMemo, useState } from "react";
import { FiChevronDown, FiCopy, FiGlobe, FiMousePointer } from "react-icons/fi";
import { appendComposerText } from "../composer-text";
import { copyText } from "../clipboard";
import { useChatT } from "../i18n";
import { ToolOutputDownload } from "./ToolOutputDownload";

type ElementRow = { id: number; role: string; label: string };
type Snapshot = {
	snapshot: string;
	title?: string;
	url?: string;
	excerpt?: string;
	hasForm?: boolean;
	text: string;
	elements: ElementRow[];
	textTruncated?: boolean;
	elementsTruncated?: boolean;
};
function parseSnapshot(raw: string): Snapshot | undefined {
	try {
		const data = JSON.parse(raw);
		if (typeof data?.snapshot !== "string" || typeof data.text !== "string" || !Array.isArray(data.elements)) return;
		if (
			!data.elements.every((e: ElementRow) => Number.isSafeInteger(e?.id) && typeof e.role === "string" && typeof e.label === "string")
		)
			return;
		if (["title", "url", "excerpt"].some(key => data[key] !== undefined && typeof data[key] !== "string")) return;
		return data;
	} catch {
		return;
	}
}
const tabs = ["snapSummary", "snapElements", "snapRaw"] as const;
const groups = ["snapAll", "snapClickable", "snapLinks", "snapButtons", "snapInputs"] as const;
function group(role: string) {
	if (role === "a" || role === "link") return "snapLinks";
	if (role === "button") return "snapButtons";
	if (["input", "textarea", "select", "textbox", "combobox", "searchbox", "spinbutton"].includes(role)) return "snapInputs";
}
export function BrowserSnapshotCard({
	id,
	raw,
	truncated,
	downloadUrl,
	conversationId,
}: {
	id: string;
	raw: string;
	truncated: boolean;
	downloadUrl?: string;
	conversationId?: string;
}) {
	const t = useChatT();
	const uid = useId();
	const data = useMemo(() => parseSnapshot(raw), [raw]);
	const [tab, setTab] = useState<(typeof tabs)[number]>("snapSummary");
	const [filter, setFilter] = useState<(typeof groups)[number]>("snapAll");
	const [search, setSearch] = useState("");
	const [expanded, setExpanded] = useState(false);
	const [open, setOpen] = useState(true);
	const [notice, setNotice] = useState("");
	const rows = data?.elements ?? [];
	const links = rows.filter(e => group(e.role) === "snapLinks").length;
	const buttons = rows.filter(e => group(e.role) === "snapButtons").length;
	const text = data?.text ?? "";
	const lines = text.trim().split(/\r?\n/);
	const preview = lines.slice(0, 10).join("\n").slice(0, 700);
	const excerpt =
		data?.excerpt ||
		lines
			.find(line => line.trim().length >= 35)
			?.trim()
			.slice(0, 200) ||
		"";
	const counts = t("snapCounts", { chars: Array.from(text).length, elements: rows.length, links, buttons });
	const keyElements = rows
		.filter(e => e.label.trim() && (group(e.role) === "snapButtons" || group(e.role) === "snapLinks"))
		.slice(0, 3);
	const title = data?.title || t("snapUntitled");
	const summary = [title, data?.url, counts, excerpt].filter(Boolean).join("\n");
	const json = useMemo(() => (tab === "snapRaw" && data ? JSON.stringify(data, null, 2) : raw), [raw, data, tab]);
	const query = search.trim().toLowerCase();
	const filtered = rows.filter(e => {
		const kind = group(e.role);
		return (
			(filter === "snapAll" || filter === kind || (filter === "snapClickable" && (kind === "snapLinks" || kind === "snapButtons"))) &&
			(!query || (/^\d+$/.test(query) ? String(e.id) === query : [e.label, e.role].join(" ").toLowerCase().includes(query)))
		);
	});
	const copy = async (value: string, doc: Document) => {
		try {
			await copyText(value, doc);
			setNotice(t("copied"));
		} catch {
			setNotice(t("copyFailed"));
		}
	};
	const copyButton = (label: string, value: string) => (
		<button className="snap-action" onClick={e => void copy(value, e.currentTarget.ownerDocument)}>
			<FiCopy aria-hidden="true" />
			{label}
		</button>
	);
	const selectTab = (next: typeof tab) => {
		setTab(next);
		setNotice("");
	};
	return (
		<section className="snapshot-card" data-tool-call-id={id}>
			<button className="snap-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<FiGlobe aria-hidden="true" />
				<strong>{t("browserActionSnapshot")}</strong>
				<FiChevronDown className={open ? "" : "closed"} aria-hidden="true" />
			</button>
			{open && (
				<div className="snap-body">
					{data && (
						<header>
							<strong className="snap-title">{title}</strong>
							{data.url && <div className="snap-url">{data.url}</div>}
							<div className="snap-counts">{counts}</div>
						</header>
					)}
					<div className="snap-tabs" role="tablist" aria-label={t("browserActionSnapshot")}>
						{tabs
							.filter(k => data || k !== "snapElements")
							.map(k => (
								<button
									key={k}
									role="tab"
									id={uid + k}
									aria-controls={uid + "panel"}
									aria-selected={k === tab}
									tabIndex={k === tab ? 0 : -1}
									onClick={() => selectTab(k)}
									onKeyDown={e => {
										const list = Array.from(e.currentTarget.parentElement!.querySelectorAll<HTMLButtonElement>("[role=tab]"));
										const index = list.indexOf(e.currentTarget);
										const next =
											e.key === "Home"
												? 0
												: e.key === "End"
													? list.length - 1
													: e.key === "ArrowLeft"
														? (index + list.length - 1) % list.length
														: e.key === "ArrowRight"
															? (index + 1) % list.length
															: -1;
										if (next >= 0) {
											e.preventDefault();
											list[next].focus();
											list[next].click();
										}
									}}
								>
									{t(k)}
								</button>
							))}
					</div>
					<div role="tabpanel" id={uid + "panel"} aria-labelledby={uid + tab}>
						{tab === "snapSummary" &&
							(data ? (
								<>
									{excerpt && <p className="snap-excerpt">{excerpt}</p>}
									<div className="snap-section-head">
										<h4>{t("snapBody")}</h4>
										{text && copyButton(t("snapCopyText"), text)}
									</div>
									<div className="snap-text">{(expanded ? text : preview) || t("snapEmptyText")}</div>
									{text.trim() !== preview && (
										<button className="snap-action" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
											{t(expanded ? "snapLess" : "snapMore")}
										</button>
									)}
									{keyElements.length > 0 && (
										<div className="snap-key">
											<h4>{t("snapKey")}</h4>
											{keyElements.map(e => (
												<button
													key={e.id}
													className="snap-action"
													title={e.label}
													onClick={() => {
														setFilter("snapAll");
														setSearch(String(e.id));
														selectTab("snapElements");
													}}
												>
													{e.label}
												</button>
											))}
										</div>
									)}
									{(data.textTruncated || data.elementsTruncated) && <p className="snap-muted">{t("snapLimited")}</p>}
									<div className="snap-footer">
										{copyButton(t("snapCopySummary"), summary)}
										{rows.length > 0 && (
											<button
												className="snap-action"
												onClick={() => {
													setFilter("snapClickable");
													setSearch("");
													selectTab("snapElements");
												}}
											>
												{t("snapClickable")}
											</button>
										)}
									</div>
									<details className="snap-meta">
										<summary>{t("snapMetadata")}</summary>
										<div>
											<code>{data.snapshot}</code>
											{copyButton(t("snapCopyId"), data.snapshot)}
										</div>
										{typeof data.hasForm === "boolean" && <span>{t(data.hasForm ? "snapHasForm" : "snapNoForm")}</span>}
									</details>
								</>
							) : (
								<p>{t(truncated ? "snapIncomplete" : "snapUnreadable")}</p>
							))}
						{tab === "snapElements" && data && (
							<>
								<div className="snap-filters">
									<input
										type="search"
										aria-label={t("snapFind")}
										placeholder={t("snapFind")}
										value={search}
										onChange={e => setSearch(e.target.value)}
									/>
									<select aria-label={t("snapFilter")} value={filter} onChange={e => setFilter(e.target.value as typeof filter)}>
										{groups.map(k => (
											<option key={k} value={k}>
												{t(k)}
											</option>
										))}
									</select>
								</div>
								<div className="snap-table">
									<table>
										<thead>
											<tr>
												<th>ID</th>
												<th>{t("snapRole")}</th>
												<th>{t("snapLabel")}</th>
												{conversationId && <th aria-label={t("snapPrepare")} />}
											</tr>
										</thead>
										<tbody>
											{filtered.map(e => (
												<tr key={e.id}>
													<td>{e.id}</td>
													<td>
														<code>{e.role}</code>
													</td>
													<td>{e.label || "—"}</td>
													{conversationId && (
														<td>
															<button
																className="snap-action"
																title={t("snapPrepare")}
																aria-label={t("snapPrepare") + " " + e.id}
																onClick={() => {
																	appendComposerText(conversationId, t("snapPrompt", { id: e.id, snapshot: data.snapshot }));
																	setNotice(t("snapDraft"));
																}}
															>
																<FiMousePointer aria-hidden="true" />
															</button>
														</td>
													)}
												</tr>
											))}
										</tbody>
									</table>
									{!filtered.length && <p>{t("snapNoMatches")}</p>}
								</div>
							</>
						)}
						{tab === "snapRaw" && (
							<>
								{!truncated && copyButton(t("snapCopyRaw"), raw)}
								<pre className="snap-json">{json}</pre>
							</>
						)}
						{truncated && downloadUrl && <ToolOutputDownload url={downloadUrl} />}
					</div>
					{notice && <small role="status">{notice}</small>}
				</div>
			)}
		</section>
	);
}
