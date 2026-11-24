import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n";
import { richCodeText } from "../rich-code-text";
import { randomUuid } from "../uuid";
import { runNotebookCell, wikiRequest } from "../wiki-api";
import type { NotebookCellOutput } from "../types";
import { CopyButton } from "./copy-button";
import { cellText } from "../../../server/notebook";
import { FiPlay, FiSquare, FiCheckCircle, FiAlertCircle, FiTrash2 } from "react-icons/fi";
import { WikiReadingDialog } from "./WikiReading";
import { Output } from "./NotebookEditor";

export type KernelBlock = { id: string; code: HTMLElement; prompt: HTMLElement; button: HTMLElement; output: HTMLElement };
export type KernelOwner = { conversationId: string; busyRef: { current: boolean } };

export function MarkdownKernel({ cwd, path, conversationId, busyRef, blocks, disabled, onDelete }: KernelOwner & {
	cwd: string; path: string; blocks: KernelBlock[]; disabled: boolean; onDelete: (targets: KernelBlock[]) => void;
}) {
	const t = useT();
	const [kernelId] = useState(randomUuid);
	const [running, setRunning] = useState("");
	const results = useRef(new WeakMap<HTMLElement, { source: string; outputs: NotebookCellOutput[]; count: number | null; error?: string; missing?: boolean }>());
	const [, refresh] = useState(0);
	const alive = useRef(true);
	const used = useRef(false);
	const previousBlocks = useRef<KernelBlock[]>([]);
	useEffect(() => {
		const current = new Set(blocks);
		for (const previous of previousBlocks.current) {
			if (!current.has(previous)) results.current.delete(previous.code);
		}
		previousBlocks.current = blocks;
	}, [blocks]);
	const body = { conversationId, path, kernelId };
	const control = (action: string) => wikiRequest(cwd, "notebook-" + action, body);
	useEffect(() => {
		alive.current = true;
		const leave = (e: BeforeUnloadEvent) => { if (busyRef.current) e.preventDefault(); };
		const close = () => { if (used.current) void control("close").catch(() => {}); };
		window.addEventListener("beforeunload", leave);
		window.addEventListener("pagehide", close);
		return () => {
			alive.current = false;
			busyRef.current = false;
			window.removeEventListener("beforeunload", leave);
			window.removeEventListener("pagehide", close);
			close();
		};
	}, [cwd, path, conversationId, kernelId]);
	async function run(block: KernelBlock, install = false, advance = false) {
		if (busyRef.current) return;
		used.current = true;
		busyRef.current = true;
		setRunning(install ? "install" : block.id);
		const source = richCodeText(block.code);
		const result = { source, outputs: [] as NotebookCellOutput[], count: null as number | null, error: "", missing: false };
		results.current.set(block.code, result);
		try {
			if (install) await control("install");
			else {
				const response = await runNotebookCell(cwd, { ...body, requestId: randomUuid(), code: source }, output => {
					if (!alive.current || !block.code.isConnected) return;
					if (output.output_type === "clear_output") result.outputs = [];
					else result.outputs.push(output);
					refresh(n => n + 1);
				});
				result.outputs = response.outputs;
				result.count = response.execution_count;
			}
		} catch (error) {
			result.error = (error as Error).message;
			result.missing = /No module named ['"](?:ipykernel|ipykernel_launcher|jupyter_client)['"]/.test(result.error);
			if (result.missing) result.error = t("nbMissingRuntime");
		} finally {
			if (alive.current) {
				busyRef.current = false;
				setRunning("");
				const index = blocks.findIndex(item => item.id === block.id), next = index >= 0 ? blocks[index + 1] : undefined;
				if (advance && next?.code.isConnected) {
					next.code.closest<HTMLElement>("[contenteditable]")?.focus({ preventScroll: true });
					const range = next.code.ownerDocument.createRange();
					range.selectNodeContents(next.code);
					range.collapse(false);
					const selection = next.code.ownerDocument.defaultView?.getSelection();
					selection?.removeAllRanges();
					selection?.addRange(range);
					next.code.scrollIntoView({ block: "nearest" });
				}
			}
		}
	}
	const [deleteTargets, setDeleteTargets] = useState<KernelBlock[]>([]);
	const canDelete = !disabled && deleteTargets.every(block => blocks.includes(block) && block.id !== running);
	return <>{blocks.map(block => {
		const result = results.current.get(block.code);
		const active = running === block.id;
		const label = t(active ? "nbStop" : "playgroundRun");
		return [createPortal(`In [${active ? "*" : result?.count ?? " "}]:`, block.prompt, block.id + "-prompt"), createPortal(<>
			<button type="button" data-code-run-kernel="" aria-busy={active} aria-label={label} aria-keyshortcuts={active ? undefined : "Shift+Enter Control+Enter Meta+Enter"} title={active ? label : label + " (Ctrl/⌘/Shift+Enter)"} disabled={!active && (!!running || disabled)}
				onMouseDown={e => e.preventDefault()} onClick={event => {
					if (active) void control("interrupt").catch(e => { if (result && alive.current) { result.error = e.message; refresh(n => n+1); } });
					else void run(block, false, event.shiftKey);
				}}>{active ? <FiSquare aria-hidden="true" /> : <FiPlay aria-hidden="true" />}</button>
			{!disabled && <button type="button" className="wiki-cell-delete" title={t("nbDeleteTitle")} aria-label={t("nbDeleteTitle")} aria-haspopup="dialog" disabled={active} onClick={() => setDeleteTargets([block])}><FiTrash2 aria-hidden="true" /></button>}
			{result?.missing && <button disabled={!!running} onClick={() => void run(block, true)}>{t("nbInstall")}</button>}
		</>, block.button, block.id), result && createPortal(<>
			{richCodeText(block.code) !== result.source && <small>{t("nbChanged")}</small>}
			{(result.error || result.outputs.length > 0) && <div className="nb-output"><div className="wiki-cell-output-head">{result.error || result.outputs.some(o => o.output_type === "error") ? <FiAlertCircle /> : active ? null : <FiCheckCircle />} {t("pgCellOutput")}<CopyButton text={[result.error, ...result.outputs.map(o => o.traceback?.join("\n") || cellText(o.text ?? o.data?.["text/plain"]))].filter(Boolean).join("")} /></div>{result.error}{result.outputs.map((output,i) => <div key={i} className="wiki-cell-result">
					{output.output_type === "execute_result" && result.count != null && <span className="wiki-cell-out-prompt">Out[{result.count}]:</span>}
					<Output output={output} />
				</div>)}</div>}
		</>, block.output, block.id+"-output")];
	})}
	{deleteTargets.length > 0 && !disabled && <WikiReadingDialog hideClose title={t("nbDeleteOne")} onClose={() => setDeleteTargets([])}>
		<p>{t("nbDeleteHint")}</p>
		<div className="wiki-cell-delete-actions">
			<button onClick={() => setDeleteTargets([])}>{t("cancel")}</button>
			<button disabled={!canDelete} onClick={() => { if (canDelete) onDelete(deleteTargets); setDeleteTargets([]); }}>{t("ok")}</button>
		</div>
	</WikiReadingDialog>}</>;
}
