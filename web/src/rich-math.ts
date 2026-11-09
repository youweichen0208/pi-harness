import katex from "katex";
import "katex/dist/katex.min.css";
import type { Root, RootContent } from "mdast";
import type { VFile } from "vfile";

/** Keep TeX as the source of truth; generated layout never enters saved Markdown. */
export function remarkRichMath() {
	return (tree: Root, file: VFile) => {
		const visit = (node: Root | RootContent) => {
			if (node.type === "math" || node.type === "inlineMath") {
				const display = node.type === "math";
				const raw = String(file.value).slice(node.position?.start.offset, node.position?.end.offset);
				node.data = { hName: display ? "div" : "span", hProperties: {
					"data-rich-math": node.value, "data-rich-math-display": String(display),
					"data-rich-math-source": raw, contentEditable: "false", className: ["rich-math"],
				}, hChildren: [{ type: "text", value: node.value }] };
			}
			if ("children" in node) for (const child of node.children) visit(child);
		};
		visit(tree);
	};
}

export function paintMath(element: HTMLElement): void {
	const source = element.dataset.richMath ?? "";
	try {
		if (source.length > 16000) throw new Error("Formula too long");
		katex.render(source, element, { displayMode: element.dataset.richMathDisplay === "true", trust: false, throwOnError: true, maxExpand: 1000, maxSize: 10 });
		element.removeAttribute("data-math-error");
	} catch {
		element.textContent = source;
		element.dataset.mathError = "";
	}
}

export function createMath(source: string, display: boolean): HTMLElement {
	const element = document.createElement(display ? "div" : "span");
	element.className = "rich-math";
	element.contentEditable = "false";
	element.dataset.richMath = source;
	element.dataset.richMathDisplay = String(display);
	element.dataset.richMathSource = display ? `$$\n${source}\n$$` : `$${source}$`;
	paintMath(element);
	return element;
}
