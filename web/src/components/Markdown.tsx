import { useChangeLinks } from "../changes-context";
import { remarkChangeLinks } from "../remark-change-links";
import { remarkTextHighlight } from "../remark-text-highlight";
import { memo, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import type { PluggableList } from "unified";
import remarkGfm from "remark-gfm";
import { remarkHighlightBlock } from "../remark-highlight-block";
import rehypeHighlight from "rehype-highlight";
import { remarkCjkAutolink } from "../remark-cjk-autolink";
import { CopyButton } from "./copy-button";
import { MermaidDiagram } from "./MermaidDiagram";
import { DesignTree } from "./DesignTree";
import { parseTextTree } from "../design-tree";

interface MarkdownProps {
	text: string;
	imageSrc?: (source: string) => string;
	/** Source positions let the file preview quote rendered text with Markdown syntax. */
	sourceLines?: boolean;
	/** Interpret local file references in user-pasted text. */
	fileLinks?: boolean;
}

/** Shared markdown pipeline + codeblock chrome (copy button). Exported so
 *  StreamMarkdown's per-segment renderers reuse the exact same configuration
 *  as this full-document renderer — streaming preview and final render must
 *  be visually identical. */
// remarkCjkAutolink 必须排在 remarkGfm 后面：它修的正是 gfm 自动链接把中文
// 标点吞进 URL 的结果。
export const remarkPlugins = [remarkGfm, remarkCjkAutolink, remarkHighlightBlock, remarkTextHighlight];
export const rehypePlugins: PluggableList = [
	[rehypeHighlight, { detect: true, ignoreMissing: true }],
];

const sourceLineComponents: Components = {
	p: ({ node, ...props }) => <p {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	li: ({ node, ...props }) => <li {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h1: ({ node, ...props }) => <h1 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h2: ({ node, ...props }) => <h2 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h3: ({ node, ...props }) => <h3 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h4: ({ node, ...props }) => <h4 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h5: ({ node, ...props }) => <h5 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
	h6: ({ node, ...props }) => <h6 {...props} data-source-start={node?.position?.start.line} data-source-end={node?.position?.end.line} />,
};

/** Chat headings: a trailing "(不用你回答)" reads as a quiet subtitle, not part of the title. */
function withHeadingNote(children: ReactNode): ReactNode {
	const parts = Array.isArray(children) ? [...children] : [children];
	const last = parts.at(-1);
	if (typeof last !== "string") return children;
	const match = /^([\s\S]*?\S)\s*[(（]([^()（）]{1,40})[)）]\s*$/.exec(last);
	if (!match && !(parts.length > 1 && /^\s*[(（]([^()（）]{1,40})[)）]\s*$/.test(last))) return children;
	const note = match ? match[2] : last.replace(/^\s*[(（]|[)）]\s*$/g, "");
	parts[parts.length - 1] = match ? match[1] : "";
	return <>{parts}<small className="md-heading-note">{note}</small></>;
}

const headingNotes: Components = Object.fromEntries((["h1", "h2", "h3", "h4"] as const).map(Tag => [Tag, ({ node: _node, children, ...props }: JSX.IntrinsicElements["h2"] & { node?: unknown }) => <Tag {...props}>{withHeadingNote(children)}</Tag>]));

export function MarkdownBody({ text, imageSrc, sourceLines, fileLinks }: MarkdownProps) {
	const changes = useChangeLinks();
	const links = changes && !sourceLines ? [...remarkPlugins, remarkChangeLinks(changes.files.map(file => file.path))] : remarkPlugins;
	return (
		<ReactMarkdown remarkPlugins={links} rehypePlugins={rehypePlugins} components={{ pre: ({ children, ...props }) => <PreWithCopy {...props} fileLinks={fileLinks}>{children}</PreWithCopy>, li: RouteListItem, a: ({ node: _node, href, children, ...props }) => {
			const pr = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)(?:[?#].*)?$/.exec(href ?? "");
			return <a {...props} href={href} className={pr ? "pr-reference" : undefined} onClick={event => {
				if (href?.startsWith("#pi-change=")) { event.preventDefault(); const path = decodeURIComponent(href.slice(11)); changes?.show(changes.files, path); }
				else if (fileLinks && href?.startsWith("#pi-file=")) { event.preventDefault(); openLocalFile(href.slice(9)); }
				else if (changes && href && !/^(?:[a-z]+:|#|\/\/)/i.test(href) && /\.[a-z0-9]+(?:#L\d+)?$/i.test(href)) { event.preventDefault(); const [path, line] = href.split("#L"); const file = changes.files.find(file => file.path === path); if (file) changes.show(changes.files, file.path); else window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", { detail: { path: decodeURIComponent(path), line: Number(line) || 1 } })); }
			}}>{pr ? `#${pr[1]}` : children}</a>;
		}, ...(sourceLines ? sourceLineComponents : headingNotes), ...(imageSrc ? { img: ({ node: _node, src, ...props }) => <img {...props} src={imageSrc(src ?? "")} /> } : {}) }}>
			{text}
		</ReactMarkdown>
	);
}

/** GFM markdown with syntax highlighting; code blocks get a copy button. */
export const Markdown = memo(function Markdown({ text, imageSrc, sourceLines, fileLinks }: MarkdownProps) {
	return (
		<div className="md">
			<MarkdownBody text={text} imageSrc={imageSrc} sourceLines={sourceLines} fileLinks={fileLinks} />
		</div>
	);
});

export function PreWithCopy({ children, fileLinks, showLanguage, ...props }: JSX.IntrinsicElements["pre"] & { fileLinks?: boolean; showLanguage?: boolean }) {
	if (isMermaidCodeBlock(children)) {
		return <MermaidDiagram code={codeText(children)} />;
	}
	const asciiTable = fileLinks && isAsciiTableCodeBlock(children);
	const code = codeText(children);
	const child = Array.isArray(children) ? children[0] : children;
	const language = child && typeof child === "object" && "props" in child ? /language-([\w+-]+)/.exec(String(child.props.className ?? ""))?.[1] : undefined;
	// Replies draw design trees as box-drawing art; user-pasted text keeps its exact shape.
	const tree = !fileLinks && !showLanguage ? parseTextTree(code) : null;
	if (tree) return <DesignTree tree={tree} source={code} />;
	return (
		<div className={`codeblock${asciiTable ? " ascii-table" : ""}`}>
			{showLanguage ? <div className="codeblock-heading"><span>{language}</span><CopyButton text={code} label /></div> : <>
				{language && <div className="codeblock-bar"><span>{language}</span><CopyButton text={code} label /></div>}
				<CopyButton text={code} />
			</>}
			<pre {...props}>{asciiTable ? <code>{linkedFilePaths(code)}</code> : children}</pre>
		</div>
	);
}

function isAsciiTableCodeBlock(children: unknown): boolean {
	const child = Array.isArray(children) ? children[0] : children;
	return !!child && typeof child === "object" && "props" in child &&
		/(^|\s)language-ascii-table(\s|$)/.test(String((child as { props?: { className?: unknown } }).props?.className ?? ""));
}

function openLocalFile(reference: string): void {
	const match = /^(.+):([1-9]\d*)$/.exec(reference);
	if (!match) return;
	try {
		window.dispatchEvent(new CustomEvent("pi-harness:open-tool-file", { detail: { path: decodeURIComponent(match[1]), line: Number(match[2]) } }));
	} catch { /* Ignore malformed links pasted into a message. */ }
}

function linkedFilePaths(code: string) {
	const pattern = /((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]+):([1-9]\d*)/g;
	const parts: (string | JSX.Element)[] = [];
	let offset = 0;
	for (const match of code.matchAll(pattern)) {
		const start = match.index;
		if (start > offset) parts.push(code.slice(offset, start));
		const reference = `${match[1]}:${match[2]}`;
		parts.push(<a key={start} href={`#pi-file=${encodeURIComponent(match[1])}:${match[2]}`} onClick={(event) => { event.preventDefault(); openLocalFile(`${encodeURIComponent(match[1])}:${match[2]}`); }}>{reference}</a>);
		offset = start + match[0].length;
	}
	if (offset < code.length) parts.push(code.slice(offset));
	return parts;
}

/** True when `children` is the single ```mermaid fenced-code element that
 *  react-markdown/rehype-highlight hand to a <pre>'s children. */
function isMermaidCodeBlock(children: unknown): boolean {
	const child = Array.isArray(children) ? children[0] : children;
	if (!child || typeof child !== "object" || !("props" in child)) return false;
	const className = (child as { props?: { className?: unknown } }).props?.className;
	return typeof className === "string" && /(^|\s)language-mermaid(\s|$)/.test(className);
}

function codeText(children: unknown): string {
	if (typeof children === "string") return children;
	if (Array.isArray(children)) return children.map(codeText).join("");
	if (children && typeof children === "object" && "props" in children) {
		const props = (children as { props?: { children?: unknown } }).props;
		return codeText(props?.children);
	}
	return "";
}

const ROUTE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/;

/** `GET /todos` list items render as a method tag plus the path. */
function RouteListItem({ node: _node, children, ...props }: JSX.IntrinsicElements["li"] & { node?: unknown }) {
	const items = Array.isArray(children) ? children : [children];
	const first = items.findIndex(child => !(typeof child === "string" && !child.trim()));
	const head = items[first] as { type?: unknown; props?: { children?: unknown } } | undefined;
	const text = head?.type === "code" && typeof head.props?.children === "string" ? head.props.children : "";
	const route = ROUTE.exec(text);
	if (!route) return <li {...props}>{children}</li>;
	return <li {...props} className="api-route"><span className={`method-tag ${route[1].toLowerCase()}`}>{route[1]}</span><code>{route[2]}</code>{items.slice(first + 1)}</li>;
}
