/** Controlled HTML is a small document format, never a general HTML renderer. */
export const FONT_SIZES = [12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 48];
export const LINE_HEIGHTS = [1, 1.5, 1.74, 2, 2.5, 3];
export function safeLink(value: string): boolean {
	if (/[\u0000-\u001f<>]/.test(value) || value.startsWith("//")) return false;
	try { return ["http:", "https:", "mailto:"].includes(new URL(value, "https://document.invalid/").protocol); } catch { return false; }
}
export function cleanStyle(style: CSSStyleDeclaration): string {
	const result: string[] = [];
	if (FONT_SIZES.includes(Number.parseFloat(style.fontSize))) result.push(`font-size: ${Number.parseFloat(style.fontSize)}px`);
	if (LINE_HEIGHTS.includes(Number(style.lineHeight))) result.push(`line-height: ${style.lineHeight}`);
	if (["left", "center", "right", "justify"].includes(style.textAlign)) result.push(`text-align: ${style.textAlign}`);
	for (const key of ["color", "background-color"]) {
		const value = style.getPropertyValue(key);
		if (/^(?:#[a-f\d]{3,8}|rgba?\([\d., %]+\)|oklch\([\d. %/]+\)|transparent)$/i.test(value)) result.push(`${key}: ${value}`);
	}
	if (["bold", "700", "normal", "400"].includes(style.fontWeight)) result.push(`font-weight: ${["bold", "700"].includes(style.fontWeight) ? "700" : "400"}`);
	if (["italic", "normal"].includes(style.fontStyle)) result.push(`font-style: ${style.fontStyle}`);
	if (/^(?:underline|line-through)(?: (?:underline|line-through))?$/.test(style.textDecorationLine || style.textDecoration)) result.push(`text-decoration: ${style.textDecorationLine || style.textDecoration}`);
	return result.join("; ");
}
const tags = new Set("P DIV SPAN DETAILS SUMMARY FIGURE FIGCAPTION A IMG STRONG B EM I U S DEL SUB SUP MARK BR HR UL OL LI INPUT BLOCKQUOTE PRE CODE TABLE THEAD TBODY TR TH TD H1 H2 H3 H4 H5 H6".split(" "));
export function cleanRichHtml(html: string): string | null {
	const parsed = new DOMParser().parseFromString(html, "text/html");
	if (parsed.querySelector("script,style,iframe,object,embed,svg,math")) return null;
	for (const el of [...parsed.body.querySelectorAll<HTMLElement>("*")]) {
		if (!tags.has(el.tagName)) return null;
		const style = cleanStyle(el.style);
		for (const attr of [...el.attributes]) {
			const { name, value } = attr;
			const keep = name === "data-rich-collapse" || name === "data-rich-format" || (name === "data-rich-card" && value === "1")
				|| (name === "data-rich-highlight" && ["note", "tip", "warning"].includes(value))
				|| (name === "href" && el.tagName === "A" && safeLink(value))
				|| (name === "src" && el.tagName === "IMG" && safeLink(value) && !/^mailto:/i.test(value))
				|| (name === "alt" && el.tagName === "IMG")
				|| (name === "type" && el.tagName === "INPUT" && value === "checkbox")
				|| (name === "checked" && el.tagName === "INPUT")
				|| (name === "class" && el.tagName === "CODE" && /^language-[\w+-]+$/.test(value));
			if (!keep) el.removeAttribute(name);
		}
		if (el.tagName === "INPUT") el.setAttribute("type", "checkbox");
		if (style) el.setAttribute("style", style);
	}
	return parsed.body.innerHTML.replace(/\n/g, "&#10;").replace(/\r/g, "&#13;");
}
export function controlledBlock(raw: string): string | null {
	if (!/^<(?:details\b[^>]*data-rich-collapse|figure\b[^>]*data-rich-card=["']1["']|(?:p|div|ul|ol|table|h[1-6])\b[^>]*data-rich-format)/i.test(raw)) return null;
	return cleanRichHtml(raw);
}

/** Editing uses ordinary blocks because Chromium's insertHTML unwraps SUMMARY. */
export function editableDisclosures(root: HTMLElement, label: string) {
	root.querySelectorAll<HTMLDetailsElement>("details[data-rich-collapse]").forEach(details => {
		const block = document.createElement("div"); block.dataset.richCollapse = "";
		const title = document.createElement("p"); title.dataset.richSummary = "";
		const summary = details.querySelector(":scope > summary"); title.innerHTML = summary?.innerHTML ?? label; summary?.remove();
		const body = document.createElement("div"); body.dataset.richCollapseBody = ""; body.append(...details.childNodes); block.append(title, body); details.replaceWith(block);
	});
	root.querySelectorAll<HTMLElement>("div[data-rich-collapse]").forEach(block => {
		if (block.querySelector(":scope > [data-rich-ui]")) return;
		const button = document.createElement("button"); button.type = "button"; button.dataset.richUi = ""; button.contentEditable = "false"; button.textContent = "▾"; button.setAttribute("aria-label", label); button.setAttribute("aria-expanded", "true");
		button.onmousedown = e => e.preventDefault();
		button.onclick = () => { const body = block.querySelector<HTMLElement>(":scope > [data-rich-collapse-body]"); if (!body) return; body.hidden = !body.hidden; button.textContent = body.hidden ? "▸" : "▾"; button.setAttribute("aria-expanded", String(!body.hidden)); };
		block.prepend(button);
	});
}
export function canonicalDisclosures(root: HTMLElement) {
	root.querySelectorAll<HTMLElement>("div[data-rich-collapse]").forEach(block => {
		const details = document.createElement("details"); details.dataset.richCollapse = "";
		const summary = document.createElement("summary"); summary.innerHTML = block.querySelector(":scope > [data-rich-summary]")?.innerHTML ?? "";
		const body = block.querySelector(":scope > [data-rich-collapse-body]"); details.append(summary, ...(body ? [...body.childNodes] : [])); block.replaceWith(details);
	});
	root.querySelectorAll("details[data-rich-collapse]").forEach(node => node.removeAttribute("open"));
}
