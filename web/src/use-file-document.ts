import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { FileDocument } from "./file-document";
import type { ClientMessage, FileContent, ServerMessage } from "./types";

export function useFileDocument(file: { cwd: string; path: string; name: string }, send: (message: ClientMessage) => boolean, autoSave: boolean, connected: boolean, disabled: boolean, content: FileContent | null, result: Extract<ServerMessage, { type: "file_result" }> | null, changed?: { path: string } | null) {
	const transport = useRef(send); transport.current = send;
	// The preview host keys each mount by cwd:path.
	const [document] = useState(() => new FileDocument(file, message => transport.current(message), autoSave));
	const state = useSyncExternalStore(document.subscribe, document.getSnapshot);
	useLayoutEffect(() => { document.observe(connected, disabled); }, [document, connected, disabled]);
	useEffect(document.connect, [document]);
	useEffect(() => { document.receiveContent(content); }, [document, content]);
	useEffect(() => { document.receiveResult(result); }, [document, result]);
	useEffect(() => { if (changed) document.externalChanged(); }, [document, changed]);
	useEffect(() => {
		if (!document.dirty) return;
		const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
		window.addEventListener("beforeunload", prevent);
		return () => window.removeEventListener("beforeunload", prevent);
	}, [document, state]);
	return { document, ...state };
}
