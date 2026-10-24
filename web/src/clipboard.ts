// A portal's JS runs in its opener, but clipboard access belongs to the
// focused window that owns the button. Never use the module-global navigator.
export async function copyText(text: string, doc: Document) {
	try {
		const clipboard = doc.defaultView?.navigator.clipboard;
		if (clipboard) { await clipboard.writeText(text); return; }
	} catch { /* Some embedded windows deny the async clipboard API. */ }
	const active = doc.activeElement as HTMLElement | null;
	const selection = doc.getSelection();
	const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
	const input = doc.createElement("textarea");
	input.value = text;
	input.readOnly = true;
	input.tabIndex = -1;
	input.className = "clipboard-copy-fallback";
	doc.body.appendChild(input);
	try {
		input.select();
		if (!doc.execCommand("copy")) throw new Error("Clipboard copy failed");
	} finally {
		input.remove();
		active?.focus({ preventScroll: true });
		if (selection) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
	}
}

