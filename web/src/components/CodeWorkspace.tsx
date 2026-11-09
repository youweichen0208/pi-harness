import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { FiCode, FiColumns, FiMaximize2, FiMinimize2, FiX } from "react-icons/fi";
import { useT } from "../i18n";
import type { PreviewFile } from "./FilePreview";

export function CodeWorkspace({ file, navigation, children, search, onPick, onClose }: {
	file: PreviewFile; navigation: ReactNode; children: ReactNode; search: ReactNode;
	onPick: (path: string, name: string) => void; onClose: () => void;
}) {
	const t = useT();
	const dialog = useRef<HTMLDialogElement>(null);
	const [tabs, setTabs] = useState<PreviewFile[]>([file]);
	const [wide, setWide] = useState(false);
	const [tree, setTree] = useState(() => !matchMedia("(max-width: 760px)").matches);
	useEffect(() => { setTabs(previous => previous.some(item => item.path === file.path) ? previous : [...previous.slice(-7), file]); }, [file]);
	useLayoutEffect(() => {
		const opener = document.activeElement;
		const element = dialog.current!; element.showModal();
		return () => { element.close(); if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }); };
	}, []);
	return createPortal(<dialog ref={dialog} className={`code-workspace design-workspace ${wide ? "maximized" : ""} ${tree ? "tree-open" : ""}`} aria-label={t("codeWorkspaceTitle")} onCancel={event => { event.preventDefault(); if (!search) onClose(); }}>
		<div className="code-workspace-layout">
			<aside className="code-workspace-tree" onClick={event => { if (matchMedia("(max-width: 760px)").matches && (event.target as Element).closest("button.file-name")) setTree(false); }}>
				{navigation}
			</aside>
			<section className="code-workspace-main">
				<header className="code-workspace-tabs">
					<button className="code-workspace-control" type="button" title={t("codeWorkspaceExplorer")} aria-label={t("codeWorkspaceExplorer")} aria-expanded={tree} onClick={() => setTree(value => !value)}><FiColumns /></button>
					<nav aria-label={t("codeWorkspaceFiles")}>{tabs.map(item => <button type="button" key={item.path} title={item.path} aria-current={item.path === file.path ? "page" : undefined} onClick={() => onPick(item.path, item.name)}><FiCode /><span>{item.name}</span></button>)}</nav>
					<button className="code-workspace-control" type="button" aria-label={t(wide ? "codeWorkspaceRestore" : "codeWorkspaceMaximize")} onClick={() => setWide(value => !value)}>{wide ? <FiMinimize2 /> : <FiMaximize2 />}</button>
					<button className="code-workspace-control" type="button" aria-label={t("close")} onClick={onClose}><FiX /></button>
				</header>
				{children}
			</section>
		</div>{search}
	</dialog>, document.body);
}
