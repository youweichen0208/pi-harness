import { expect, test } from "vitest";
import { parseTextTree } from "../../web/src/design-tree.js";

const tree = `根:参照 V2.0 设计,产出可落地的架构
├── A. 交付物形态(文档?代码?两者?)          ← 本轮
├── B. 仓库与平台定位(trading-core 是什么)   ← 本轮,决定一切文件放哪
├── C. 部署拓扑(单机?双 ECS?在哪)           ← 本轮
│    ├── C1. LLM 供应商与网络出海             ← 本轮
│    └── C2. 域名与 HTTPS                     ← 本轮
├── E. 安全策略落地(V2 第10节遗留的三个洞)
│    └── E1. 工具开放范围                     ← 本轮
├── F. Skills 内容与 MCP 接入                  ← 本轮(受 B 影响,但可先答)
└── G. 演化路径 ← 本轮(隶属 B)`;

test("box-drawing trees become nested rows with the shared annotation lifted out", () => {
	const parsed = parseTextTree(tree)!;
	expect(parsed.root).toBe("参照 V2.0 设计,产出可落地的架构");
	expect(parsed.commonTag).toBe("本轮");
	expect(parsed.children.map(item => item.id)).toEqual(["A", "B", "C", "E", "F", "G"]);
	expect(parsed.children[0]).toMatchObject({ title: "交付物形态", note: "文档?代码?两者?" });
	expect(parsed.children[0].tag).toBeUndefined();
	expect(parsed.children[1].tag).toBe("决定一切文件放哪");
	expect(parsed.children[2].children.map(item => [item.id, item.title])).toEqual([["C1", "LLM 供应商与网络出海"], ["C2", "域名与 HTTPS"]]);
	expect(parsed.children[4].tag).toBe("受 B 影响,但可先答");
	expect(parsed.children[5].tag).toBe("隶属 B");
});

test("ordinary code and one-line lists stay code", () => {
	expect(parseTextTree("const a = 1;\nconst b = 2;\nconst c = 3;")).toBeNull();
	expect(parseTextTree("root\n└── only")).toBeNull();
	expect(parseTextTree("src\n├── a.ts\nnot a branch\n└── b.ts")).toBeNull();
});
