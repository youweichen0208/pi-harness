import { expect, test } from "vitest";
import { composeAnswers, parseReplySegments, recommendedAnswers } from "../../web/src/question-cards.js";

const reply = `## 第一轮

❓ **Q1** - **交付物形态**：「写一下架构」具体交付什么？
(a) 纯架构文档;(b) 可部署实现;(c) 文档 + deploy/ 部署骨架。

➡️ 推荐 (c)。文档定边界，骨架能跑通 P0。

❓ **Q3** - **部署位置**：这台东西跑在哪？
(a) 单台海外 VPS;(b) 国内 ECS;(c) 办公室内网机器。员工在国内还是海外访问？

➡️ 推荐 (a)。5–20 人单机足够。

❓ **Q5** - **Hermes 运行形态**：跑 Docker 还是裸进程？

➡️ 推荐 Docker:升级回滚也简单。

---

答完这轮我会重算 frontier。`;

test("grilling questions become cards between the surrounding prose", () => {
	const segments = parseReplySegments(reply);
	expect(segments.map(segment => segment.kind)).toEqual(["markdown", "questions", "markdown"]);
	const questions = segments[1].kind === "questions" ? segments[1].questions : [];
	expect(questions.map(question => [question.id, question.title])).toEqual([["Q1", "交付物形态"], ["Q3", "部署位置"], ["Q5", "Hermes 运行形态"]]);
	expect(questions[0].options.map(option => option.key)).toEqual(["a", "b", "c"]);
	expect(questions[0].options[2]).toMatchObject({ text: "文档 + deploy/ 部署骨架", recommended: true, reason: "文档定边界，骨架能跑通 P0。" });
	expect(questions[1].prompt).toBe("这台东西跑在哪？ 员工在国内还是海外访问？");
	expect(questions[1].options[2].text).toBe("办公室内网机器");
	expect(questions[2].options).toEqual([{ text: "Docker", recommended: true, reason: "升级回滚也简单。" }]);
	const answers = recommendedAnswers(questions);
	expect(answers).toEqual({ Q1: 2, Q3: 0, Q5: 0 });
	expect(composeAnswers(questions, { ...answers, Q3: 1 }, "域名还没定")).toBe("Q1 交付物形态：(c) 文档 + deploy/ 部署骨架\nQ3 部署位置：(b) 国内 ECS\nQ5 Hermes 运行形态：Docker\n\n域名还没定");
});

test("a reply with one question mark stays ordinary markdown", () => {
	expect(parseReplySegments("❓ 你确定吗？\n(a) 是;(b) 否")).toEqual([{ kind: "markdown", text: "❓ 你确定吗？\n(a) 是;(b) 否" }]);
});
