import { useEffect, useRef, useState } from "react";
import { FiFile, FiFolder, FiX } from "react-icons/fi";
import { useDialogFocus } from "../use-dialog-focus";
import { useT } from "../i18n";
import type { ServerMessage } from "../types";

export function NodeKeyPicker({ request, onPick, onClose }: {
	request: (action: string, nodeId?: string, payload?: Record<string, unknown>) => string | null;
	onPick: (path: string) => void;
	onClose: () => void;
}) {
	const t = useT();
	const ref = useDialogFocus<HTMLDivElement>();
	const pending = useRef<string | null>(null);
	const [listing, setListing] = useState<{ path: string; parent: string; entries: { name: string; path: string; directory: boolean }[]; truncated?: boolean }>();
	const [path, setPath] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(true);
	const browse = (path?: string) => { setError(""); setBusy(true); pending.current = request("local_key_browse", undefined, { path }); if (!pending.current) { setBusy(false); setError(t("nodeOffline")); } };
	useEffect(() => {
		const listener = (event: Event) => {
			const msg = (event as CustomEvent<Extract<ServerMessage, { type: "node_event" }>>).detail;
			if (!pending.current || msg.requestId !== pending.current) return;
			setBusy(false); pending.current = null;
			if (msg.event === "failure") setError(String(msg.data?.message ?? ""));
			else if (msg.event === "result") { setListing(msg.data as typeof listing); setPath(String(msg.data?.path ?? "")); }
		};
		window.addEventListener("pi-node-event", listener);
		browse();
		return () => { pending.current = null; window.removeEventListener("pi-node-event", listener); };
	}, [request]);
	return <div className="node-modal-backdrop"><div ref={ref} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("nodeUserKey")} className="node-modal node-key-picker">
		<header className="node-modal-heading"><h2>{t("nodeUserKey")}</h2><button type="button" aria-label={t("close")} onClick={onClose}><FiX /></button></header>
		<form className="node-source-path" onSubmit={event => { event.preventDefault(); browse(path); }}><label>{t("nodeLocalDirectory")}<input disabled={busy} value={path} onChange={event => setPath(event.target.value)} /></label><button disabled={busy} type="submit">{t("nodeBrowse")}</button></form>
		<button type="button" disabled={busy || !listing || listing.path === listing.parent} onClick={() => browse(listing?.parent)}>{t("parentFolder")}</button>
		{error && <p className="node-error" role="alert">{error}</p>}
		<div className="node-key-files" aria-busy={busy}>{listing?.entries.map(entry => <button type="button" disabled={busy} key={entry.path} onClick={() => entry.directory ? browse(entry.path) : onPick(entry.path)}>{entry.directory ? <FiFolder /> : <FiFile />}<span>{entry.name}</span></button>)}</div>
		{listing?.truncated && <p>{t("listTruncated")}</p>}
		<p className="node-muted">{t("nodePrivateKeyHint")}</p>
	</div></div>;
}
