import { useCallback, useEffect, useRef, useState } from "react";
import type { Note, NoteInput, NoteResponse, NotesResponse } from "./types";
import { withToken } from "./auth-token";

type Draft = { note: Note; dirty: boolean; saving: boolean; error: number; generation: number };
async function request<T>(path = "", method = "GET", body?: unknown): Promise<T> {
	const response = await fetch(withToken(`/api/notes${path}`), { method, headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
	if (!response.ok) throw response.status;
	return response.json();
}
export function useNotes(open: boolean, connected: boolean) {
	const [notes, setNotes] = useState<Note[]>([]);
	const [selected, setSelected] = useState("");
	const [query, setQuery] = useState("");
	const [listError, setListError] = useState(false);
	const [creating, setCreating] = useState(false);
	const [, render] = useState(0);
	const drafts = useRef(new Map<string, Draft>());
	const requests = useRef(new Map<string, Promise<boolean>>());
	const refreshId = useRef(0);
	const redraw = () => render(n => n + 1);
	const refresh = useCallback(async () => {
		const token = ++refreshId.current;
		try {
			const result = await request<NotesResponse>();
			if (token !== refreshId.current) return;
			setNotes(result.notes); setListError(false);
			for (const note of result.notes) {
				const draft = drafts.current.get(note.id);
				if (!draft?.dirty && !draft?.saving && (!draft || note.version >= draft.note.version)) drafts.current.set(note.id, { note, dirty: false, saving: false, error: 0, generation: 0 });
			}
			for (const [id, draft] of drafts.current) {
				if (!result.notes.some(note => note.id === id)) {
					if (draft.dirty) draft.error = 404;
					else if (!draft.saving) drafts.current.delete(id);
				}
			}
			redraw();
		} catch { if (token === refreshId.current) setListError(true); }
	}, []);
	const save = useCallback(async (id: string): Promise<boolean> => {
		const pending = requests.current.get(id);
		if (pending) { await pending; return save(id); }
		const draft = drafts.current.get(id);
		if (!draft?.dirty) return true;
		if (draft.error === 409 || draft.error === 404) return false;
		const generation = draft.generation;
		draft.saving = true; draft.error = 0; redraw();
		const promise = (async () => {
			try {
				const { note } = await request<NoteResponse>(`/${id}`, "PUT", draft.note);
				refreshId.current++;
				if (draft.generation === generation) { draft.note = note; draft.dirty = false; }
				else draft.note = { ...draft.note, version: note.version, updatedAt: note.updatedAt };
				setNotes(items => items.map(item => item.id === id ? note : item));
				return true;
			} catch (error) { draft.error = typeof error === "number" ? error : 503; return false; }
			finally { draft.saving = false; requests.current.delete(id); redraw(); }
		})();
		requests.current.set(id, promise);
		return promise;
	}, []);
	const draft = drafts.current.get(selected);
	useEffect(() => {
		if (!draft?.dirty || draft.error) return;
		const timer = setTimeout(() => { void save(selected); }, 600);
		return () => clearTimeout(timer);
	}, [selected, draft?.generation, draft?.dirty, draft?.saving, draft?.error, save]);
	useEffect(() => { if (open) void refresh(); }, [open, connected, refresh]);
	useEffect(() => {
		const focus = () => { if (open) void refresh(); };
		window.addEventListener("focus", focus); window.addEventListener("online", focus);
		return () => { window.removeEventListener("focus", focus); window.removeEventListener("online", focus); };
	}, [open, refresh]);
	useEffect(() => {
		const protect = (event: BeforeUnloadEvent) => { if ([...drafts.current.values()].some(item => item.dirty || item.saving)) { event.preventDefault(); event.returnValue = ""; } };
		window.addEventListener("beforeunload", protect);
		return () => window.removeEventListener("beforeunload", protect);
	}, []);
	useEffect(() => { if (!open && selected) void save(selected); }, [open, selected, save]);
	const select = (id: string) => { if (selected) void save(selected); setSelected(id); };
	const edit = (patch: Partial<NoteInput>) => {
		if (!draft) return;
		draft.note = { ...draft.note, ...patch }; draft.generation++; draft.dirty = true;
		// Conflicts require an explicit reload or copy, never a silent retry.
		if (draft.error !== 409 && draft.error !== 404) draft.error = 0;
		redraw();
	};
	const create = async (copy = false) => {
		if (creating) return;
		setCreating(true);
		const generation = draft?.generation;
		refreshId.current++;
		try {
			const { note } = await request<NoteResponse>("", "POST", copy && draft ? draft.note : { title: "", body: "", pinned: false });
			refreshId.current++;
			if (copy && draft && draft.generation === generation) { draft.dirty = false; draft.error = 0; }
			drafts.current.set(note.id, { note, dirty: false, saving: false, error: 0, generation: 0 });
			setNotes(items => [note, ...items]); select(note.id); setQuery(""); setListError(false); void refresh();
		} catch { setListError(true); }
		finally { setCreating(false); }
	};
	const reload = async () => {
		if (!draft || draft.saving) return;
		const generation = draft.generation;
		try { const { note } = await request<NoteResponse>(`/${selected}`); if (draft.generation !== generation) return; refreshId.current++; drafts.current.set(selected, { note, dirty: false, saving: false, error: 0, generation: 0 }); redraw(); void refresh(); }
		catch (error) { draft.error = typeof error === "number" ? error : 503; redraw(); }
	};
	const remove = async () => {
		if (!draft || draft.saving) return;
		try { await request(`/${selected}`, "DELETE", { version: draft.note.version }); refreshId.current++; drafts.current.delete(selected); setNotes(items => items.filter(note => note.id !== selected)); setSelected(""); }
		catch (error) { draft.error = typeof error === "number" ? error : 503; redraw(); }
	};
	const retained = [...drafts.current.values()].filter(draft => draft.dirty && !notes.some(note => note.id === draft.note.id)).map(draft => draft.note);
	const visible = [...notes, ...retained].map(note => drafts.current.get(note.id)?.note ?? note)
		.filter(note => `${note.title}\n${note.body}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()))
		.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
	return { creating, notes: visible, selected, select, query, setQuery, draft, edit, create, reload, remove, save, refresh, listError };
}
export type NotesController = ReturnType<typeof useNotes>;
