/** A box-drawing tree (`├──` / `└──`) parsed into rows the UI can lay out (4a). */
export interface TreeNode {
	/** Short marker such as `A` or `C1` when the label starts with one. */
	id?: string;
	title: string;
	/** Parenthesised gloss after the title. */
	note?: string;
	/** Annotation after `←` that differs from what every branch shares. */
	tag?: string;
	children: TreeNode[];
}

export interface TextTree {
	root: string;
	children: TreeNode[];
	/** Annotation every branch carried (e.g. 本轮); shown once instead of on each row. */
	commonTag?: string;
}

const BRANCH = /^((?:[│|]\s*|\s)*)[├└][─—-]+\s?(.*)$/;

function splitAnnotation(label: string) {
	const arrow = label.search(/\s*←/);
	if (arrow < 0) return { body: label.trim(), annotation: undefined };
	return { body: label.slice(0, arrow).trim(), annotation: label.slice(arrow).replace(/^\s*←\s*/, "").trim() || undefined };
}

function node(label: string): TreeNode & { annotation?: string } {
	const { body, annotation } = splitAnnotation(label);
	const marker = /^([A-Z][0-9]*|[0-9]+(?:\.[0-9]+)*)[.、:：)]\s*(.+)$/.exec(body);
	const rest = marker ? marker[2] : body;
	// Trailing gloss in ASCII or full-width parentheses.
	const gloss = /^(.+?)\s*[(（]([^()（）]+)[)）]\s*$/.exec(rest);
	return { id: marker?.[1], title: (gloss ? gloss[1] : rest).trim(), note: gloss?.[2].trim(), annotation, children: [] };
}

/** Returns null unless every line after the root is a tree branch. */
export function parseTextTree(code: string): TextTree | null {
	const lines = code.replace(/\s+$/, "").split(/\r?\n/).filter(line => line.trim() && !/^[\s│|]+$/.test(line));
	if (lines.length < 3 || BRANCH.test(lines[0])) return null;
	const root = lines[0].trim().replace(/^根\s*[:：]\s*/, "");
	const stack: { depth: number; node: TreeNode & { annotation?: string } }[] = [];
	const top: (TreeNode & { annotation?: string })[] = [];
	const all: (TreeNode & { annotation?: string })[] = [];
	for (const line of lines.slice(1)) {
		const match = BRANCH.exec(line);
		if (!match) return null;
		const depth = match[1].replace(/\t/g, "    ").length;
		const item = node(match[2]);
		while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
		(stack.length ? stack[stack.length - 1].node.children : top).push(item);
		stack.push({ depth, node: item });
		all.push(item);
	}
	// "← 本轮, 决定一切文件放哪": the leading word most rows share becomes one header note.
	const split = (annotation: string) => {
		const match = /^([^,，;；(（]+)[,，;；]?\s*[(（]?(.*?)[)）]?$/.exec(annotation);
		return { head: (match?.[1] ?? annotation).trim(), rest: (match?.[2] ?? "").trim() };
	};
	const heads = all.flatMap(item => item.annotation ? [split(item.annotation).head] : []);
	const counts = new Map<string, number>();
	for (const head of heads) counts.set(head, (counts.get(head) ?? 0) + 1);
	const [commonTag, shared = 0] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
	const common = shared >= Math.max(2, Math.ceil(all.length / 2)) ? commonTag : undefined;
	for (const item of all) {
		const annotation = item.annotation;
		delete item.annotation;
		if (!annotation) continue;
		const { head, rest } = split(annotation);
		const tag = common && head === common ? rest : annotation;
		if (tag) item.tag = tag;
	}
	return { root, children: top, commonTag: common };
}
