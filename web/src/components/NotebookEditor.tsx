import { FiPlay, FiRotateCcw, FiSquare, FiPlus, FiArrowUp, FiArrowDown, FiTrash2, FiCode, FiType, FiSliders, FiMoreHorizontal } from "react-icons/fi";
import { useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import { cellText, newCell, readNotebook, type Notebook } from "../../../server/notebook";
import { useT } from "../i18n";
import type { NotebookCellOutput } from "../types";
import { randomUuid } from "../uuid";
import { runNotebookCell, wikiRequest } from "../wiki-api";

export function Output({ output }: { output: NotebookCellOutput }) {
	const t = useT();
	const data = output.data;
	const image = data?.["image/png"] ? "image/png" : data?.["image/jpeg"] ? "image/jpeg" : "";
	if (image) return <img alt={t("nbOutputImage")} src={`data:${image};base64,${cellText(data?.[image])}`} />;
	if (data?.["text/html"]) {
		const template = document.createElement("template");
		template.innerHTML = cellText(data["text/html"]);
		const table = template.content.querySelector("table");
		if (table)
			return (
				<table>
					<tbody>
						{Array.from(table.rows, (row, i) => (
							<tr key={i}>
								{Array.from(row.cells, (cell, j) =>
									cell.tagName === "TH" ? <th key={j}>{cell.textContent}</th> : <td key={j}>{cell.textContent}</td>,
								)}
							</tr>
						))}
					</tbody>
				</table>
			);
	}
	return (
		<pre>
			{output.traceback?.join("\n").replace(/\x1b\[[0-9;]*m/g, "") || cellText(output.text ?? data?.["text/plain"])}
		</pre>
	);
}
type Props = {
	cwd: string;
	path: string;
	conversationId: string;
	value: string;
	disabled: boolean;
	onChange(value: string): void;
	onSelect(index: number): void;
	selectedOnly: { current: boolean };
	busyRef: { current: boolean };
};
export function NotebookEditor({
	cwd,
	path,
	conversationId,
	value,
	disabled,
	onChange,
	onSelect,
	busyRef,
	selectedOnly,
}: Props) {
	const t = useT();
	const root = useRef<HTMLElement>(null);
	const [active, setActive] = useState(0),
		[editing, setEditing] = useState(-1),
		[running, setRunning] = useState(-1),
		[error, setError] = useState(""),
		[installing, setInstalling] = useState(false),
		[needsInstall, setNeedsInstall] = useState(false);
	const [optionsOpen, setOptionsOpen] = useState(false);
	const [live, setLive] = useState<NotebookCellOutput[]>([]);
	const [staleCells, setStaleCells] = useState<Set<string>>(new Set());
	const parsed = useMemo(() => {
		try {
			return readNotebook(value);
		} catch {
			return null;
		}
	}, [value]);
	const latest = useRef(value);
	latest.current = value;
	const alive = useRef(true),
		cancelled = useRef(false);
	const [kernelId] = useState(randomUuid);
	const body = { path, conversationId, kernelId };
	const call = <T,>(action: string, args = {}) => wikiRequest<T>(cwd, "notebook-" + action, { ...body, ...args });
	useEffect(() => {
		alive.current = true;
		selectedOnly.current = false;
		onSelect(0);
		const leave = (event: BeforeUnloadEvent) => {
			if (busyRef.current) event.preventDefault();
		};
		const release = () => { void call("close").catch(() => {}); };
		window.addEventListener("pagehide", release);
		window.addEventListener("beforeunload", leave);
		return () => {
			alive.current = false;
			busyRef.current = false;
			window.removeEventListener("beforeunload", leave);
			window.removeEventListener("pagehide", release);
			release();
		};
	}, [cwd, path, conversationId]);
	if (!parsed) return <p role="alert">{t("nbInvalid")}</p>;
	const book = parsed,
		locked = disabled || running >= 0 || installing;
	const python = /^python/i.test(book.metadata.language_info?.name ?? book.metadata.kernelspec?.language ?? "python");
	function save(next: Notebook) {
		latest.current = JSON.stringify(next, null, 1) + "\n";
		onChange(latest.current);
	}
	function select(i: number) {
		setActive(i);
		onSelect(i);
	}
	function cellKey(cell: Notebook["cells"][number], index: number) {
		return cell.id ?? `index:${index}`;
	}
	function change(fn: (next: Notebook) => void) {
		const next = readNotebook(latest.current), previous = next.cells.slice();
		fn(next);
		save(next);
		setStaleCells(current => {
			const remapped = new Set<string>();
			for (const key of current) {
				if (!key.startsWith("index:")) { remapped.add(key); continue; }
				const index = next.cells.indexOf(previous[Number(key.slice(6))]);
				if (index >= 0) remapped.add(cellKey(next.cells[index], index));
			}
			return remapped;
		});
	}
	function clearStale(key: string) {
		setStaleCells(current => { const next = new Set(current); next.delete(key); return next; });
	}
	function add(type: string) {
		const i = Math.min(active + 1, book.cells.length);
		change((next) => next.cells.splice(i, 0, newCell(type, randomUuid())));
		select(i);
		setEditing(i);
	}
	async function run(indexes: number[], advance = false) {
		if (locked || busyRef.current || !python) return;
		busyRef.current = true;
		cancelled.current = false;
		setError("");
		try {
			for (const i of indexes) {
				if (cancelled.current || !alive.current) break;
				const baseline = latest.current,
					cell = readNotebook(baseline).cells[i];
				if (cell.cell_type !== "code") continue;
				const key = cellKey(cell, i);
				setRunning(i);
				setLive([]);
				const result = await runNotebookCell(
					cwd,
					{ ...body, requestId: randomUuid(), code: cellText(cell.source) },
					(output) => {
						if (alive.current) setLive((items) => (output.output_type === "clear_output" ? [] : [...items, output]));
					},
				);
				if (!alive.current || baseline !== latest.current) break;
				change((next) => Object.assign(next.cells[i], result));
				clearStale(key);
				if (result.outputs.some((o) => o.output_type === "error")) break;
			}
			if (alive.current && advance) {
				const next = Math.min(indexes[0] + 1, book.cells.length - 1);
				select(next);
				root.current?.querySelectorAll<HTMLElement>("section")[next]?.focus();
			}
		} catch (e) {
			if (alive.current) {
				const message = (e as Error).message;
				const missingRuntime = /ModuleNotFoundError: No module named ['"](?:ipykernel|ipykernel_launcher|jupyter_client)['"]/.test(message);
				setError(missingRuntime ? t("nbMissingRuntime") : message);
				setNeedsInstall(missingRuntime || /ModuleNotFoundError|No module named/.test(message));
			}
		} finally {
			if (alive.current) {
				setRunning(-1);
				busyRef.current = false;
			}
		}
	}
	async function control(action: string) {
		setError("");
		cancelled.current = true;
		setInstalling(action === "install");
		try {
			await call(action);
			if (action === "install" && alive.current) setNeedsInstall(false);
		} catch (e) {
			if (alive.current) setError((e as Error).message);
		} finally {
			if (alive.current) setInstalling(false);
		}
	}
	return (
		<article className="nb-editor" ref={root}>
			<header className="nb-header">
				<h1>{path.split("/").at(-1)?.replace(/\.ipynb$/i,"")}<small>.ipynb</small></h1>
				<div className="nb-tools nb-toolbar">
					<button disabled={locked} onClick={() => add("code")}><FiPlus aria-hidden />Python</button>
					<button disabled={locked} onClick={() => add("markdown")}><FiPlus aria-hidden />Markdown</button>
					<span className="nb-divider" aria-hidden />
					{running >= 0
						? <button className="nb-primary" onClick={() => void control("interrupt")}><FiSquare aria-hidden />{t("nbStop")}</button>
						: <button className="nb-primary" disabled={locked || !python} onClick={() => void run(book.cells.map((_,i) => i))}><FiPlay aria-hidden />{t("nbRunAll")}</button>}
					<button type="button" className="nb-options" aria-expanded={optionsOpen} aria-label={t("nbOptions")} title={t("nbOptions")} onClick={() => setOptionsOpen(!optionsOpen)}><FiSliders aria-hidden /></button>
				</div>
				{optionsOpen && <div className="nb-settings">
					<label><input type="checkbox" defaultChecked={selectedOnly.current} onChange={e => {selectedOnly.current = e.target.checked;}} />{t("nbOnly")}</label>
					<button disabled={locked || !python} onClick={() => void control("close")}><FiRotateCcw aria-hidden />{t("nbRestart")}</button>
				</div>}
			</header>
			{!python && <p>{t("nbPythonOnly")}</p>}
			{error && (
				<p role="alert">
					{error}{" "}
					{needsInstall && (
						<button disabled={installing} onClick={() => void control("install")}>
							{t("nbInstall")}
						</button>
					)}
				</p>
			)}
			{installing && <p role="status">{t("nbInstalling")}</p>}
			{book.cells.map((cell, i) => (
				<section
					tabIndex={-1}
					key={cell.id ?? i}
					onFocus={() => select(i)}
					onClick={() => select(i)}
				>
					<div className="nb-tools">
						<strong>
							{cell.cell_type === "code" ? <FiCode aria-hidden /> : <FiType aria-hidden />}
							{cell.cell_type === "code"
								? `In [${running === i ? "*" : (cell.execution_count ?? " ")}]`
								: cell.cell_type}
						</strong>
						{cell.cell_type === "code" && (running === i ? (
							<button type="button" className="btn scratch-run-button" aria-label={t("nbStop")} title={t("nbStop")} onClick={() => void control("interrupt")}>
								<FiSquare aria-hidden />
							</button>
						) : (
							<button type="button" className="btn scratch-run-button is-run" aria-label={t("nbRun")} title={`${t("nbRun")} (⌘/Ctrl+Enter)`} disabled={locked || !python} onClick={() => void run([i])}>
								<FiPlay aria-hidden />
							</button>
						))}
						{cell.cell_type === "markdown" && (
							<button onClick={() => setEditing(editing === i ? -1 : i)}>
								{t(editing === i ? "nbPreview" : "nbEdit")}
							</button>
						)}
						{i === active && (
							<details className="nb-cell-actions" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }} onKeyDown={e => { if (e.key === "Escape") { e.currentTarget.open = false; e.currentTarget.querySelector("summary")?.focus(); } }}>
								<summary title={t("nbActions")} aria-label={t("nbActions")}><FiMoreHorizontal aria-hidden /></summary>
								<div className="nb-action-list" onClick={e => { const menu = e.currentTarget.parentElement; if (menu instanceof HTMLDetailsElement) menu.open = false; }}>
								<button className="nb-type"
									disabled={locked || !["markdown", "code"].includes(cell.cell_type)}
									onClick={() => {
										change((n) => {
											const c = n.cells[i];
											c.cell_type = c.cell_type === "code" ? "markdown" : "code";
											if (c.cell_type === "code") {
												c.outputs = [];
												c.execution_count = null;
											} else {
												delete c.outputs;
												delete c.execution_count;
											}
										});
										clearStale(cellKey(cell, i));
									}}
								>
									{cell.cell_type === "code" ? "→ Markdown" : "→ Python"}
								</button>
								{[-1, 1].map((d) => (
									<button
										key={d}
										title={t(d < 0 ? "nbUp" : "nbDown")}
										aria-label={t(d < 0 ? "nbUp" : "nbDown")}
										disabled={locked || !book.cells[i + d]}
										onClick={(e) => {
											e.stopPropagation();
											change((n) => n.cells.splice(i + d, 0, ...n.cells.splice(i, 1)));
											select(i + d);
										}}
									>
										{d < 0 ? <FiArrowUp aria-hidden /> : <FiArrowDown aria-hidden />}{t(d < 0 ? "nbUp" : "nbDown")}
									</button>
								))}
								<button className="nb-delete" title={t("delete")} aria-label={t("delete")} disabled={locked} onClick={event => {
									event.stopPropagation();
									change((n) => n.cells.splice(i, 1));
									select(Math.min(i, book.cells.length - 2));
									setEditing(-1);
								}}>
									<FiTrash2 aria-hidden />{t("delete")}
								</button>
								</div>
							</details>
						)}
					</div>
					{cell.cell_type === "markdown" && editing !== i ? (
						<div className="md" onDoubleClick={() => setEditing(i)}>
							<ReactMarkdown>{cellText(cell.source)}</ReactMarkdown>
						</div>
					) : (
						<textarea
							aria-label={`${cell.cell_type} ${i + 1}`}
							rows={Math.min(18, Math.max(3, cellText(cell.source).split("\n").length))}
							value={cellText(cell.source)}
							readOnly={locked}
							onChange={(e) => {
								change((n) => {
									n.cells[i].source = e.target.value;
								});
								setStaleCells(current => new Set(current).add(cellKey(cell, i)));
							}}
							onKeyDown={(e) => {
								if (e.key === "Enter" && (e.ctrlKey || e.metaKey || e.shiftKey) && !e.nativeEvent.isComposing) {
									e.preventDefault();
									void run([i], e.shiftKey);
								}
							}}
						/>
					)}
					{(running === i || !!cell.outputs?.length) && (
						<div className="nb-output">
							{running !== i && staleCells.has(cellKey(cell, i)) && <small className="nb-changed">{t("nbChanged")}</small>}
							{(running === i ? live : cell.outputs ?? []).map((output, index) => <Output key={index} output={output} />)}
						</div>
					)}
				</section>
			))}
		</article>
	);
}
