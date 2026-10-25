/**
 * GFM 自动链接遇到中文标点会一路吞到句尾（见 web/src/remark-cjk-autolink.ts
 * 顶部的说明）。这里跑真实的 remark 管线，不是手搓一棵树——要验的就是
 * remark-gfm 实际产出的节点能不能被修对。
 */
import { describe, expect, it } from "vitest";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { remarkCjkAutolink } from "../../web/src/remark-cjk-autolink.js";

interface Node {
	type: string;
	value?: string;
	url?: string;
	children?: Node[];
}

function run(md: string, withFix = true): Node {
	const proc = unified().use(remarkParse).use(remarkGfm);
	if (withFix) proc.use(remarkCjkAutolink);
	return proc.runSync(proc.parse(md)) as Node;
}

function links(tree: Node): { url: string; text: string }[] {
	const out: { url: string; text: string }[] = [];
	const walk = (n: Node) => {
		if (n.type === "link") {
			out.push({
				url: n.url ?? "",
				text: (n.children ?? []).map((c) => c.value ?? "").join(""),
			});
		}
		(n.children ?? []).forEach(walk);
	};
	walk(tree);
	return out;
}

/** 把整棵树的可见文字拼回去，用来确认截掉的部分没有丢。 */
function plainText(tree: Node): string {
	let out = "";
	const walk = (n: Node) => {
		if (typeof n.value === "string") out += n.value;
		(n.children ?? []).forEach(walk);
	};
	walk(tree);
	return out;
}

describe("remarkCjkAutolink", () => {
	const sentence =
		"已经在浏览器里打开了（http://localhost:8787），如果需要重启服务，告诉我。";

	it("不修的话 remark-gfm 确实会把后半句吞进 URL（这就是那个 bug）", () => {
		const [link] = links(run(sentence, false));
		expect(link.url).toContain("如果需要重启服务");
	});

	it("修完之后 URL 停在全角右括号前", () => {
		const [link] = links(run(sentence));
		expect(link.url).toBe("http://localhost:8787");
		expect(link.text).toBe("http://localhost:8787");
	});

	it("被截掉的那段回到正文里，一个字都不丢", () => {
		expect(plainText(run(sentence))).toBe(sentence);
	});

	it("全角逗号同样能断开", () => {
		const [link] = links(run("见 https://example.com，然后回来"));
		expect(link.url).toBe("https://example.com");
	});

	it("中文句号同样能断开", () => {
		const [link] = links(run("打开 https://example.com。"));
		expect(link.url).toBe("https://example.com");
	});

	it("路径里带中文的正常链接不误伤（只认标点不认汉字）", () => {
		const [link] = links(run("https://zh.wikipedia.org/wiki/中文"));
		expect(link.url).toBe("https://zh.wikipedia.org/wiki/中文");
	});

	it("显式写的 [文字](地址) 不碰", () => {
		const [link] = links(run("[点这里](https://example.com/a，b)"));
		expect(link.url).toBe("https://example.com/a，b");
		expect(link.text).toBe("点这里");
	});

	it("纯 ASCII 的链接照常工作", () => {
		const [link] = links(run("see https://example.com/a?b=1 ok"));
		expect(link.url).toBe("https://example.com/a?b=1");
	});

	it("成对 ** 包裹的裸链接不吞定界符，并恢复 strong 强调", () => {
		const tree = run("**http://localhost:5173**");
		expect(links(tree)).toEqual([
			{ url: "http://localhost:5173", text: "http://localhost:5173" },
		]);
		expect(plainText(tree)).toBe("http://localhost:5173");
		const paragraph = tree.children?.[0];
		expect(paragraph?.type).toBe("paragraph");
		expect(paragraph?.children?.map((child) => child.type)).toEqual(["strong"]);
		expect(paragraph?.children?.[0]?.children?.map((child) => child.type)).toEqual(["link"]);
	});

	it("链接吞入成对 ** 时去掉定界符并重建 strong", () => {
		const tree = run("**http://localhost:5173**。");
		expect(links(tree)).toEqual([
			{ url: "http://localhost:5173", text: "http://localhost:5173" },
		]);
		expect(plainText(tree)).toBe("http://localhost:5173。");
		const paragraph = tree.children?.[0];
		expect(paragraph?.children?.map((child) => child.type)).toEqual(["strong", "text"]);
		expect(paragraph?.children?.[0]?.children?.map((child) => child.type)).toEqual(["link"]);
	});

	it("一段里有多个裸链接时逐个处理", () => {
		const got = links(run("先 https://a.example，再 https://b.example。"));
		expect(got.map((l) => l.url)).toEqual([
			"https://a.example",
			"https://b.example",
		]);
	});
});
