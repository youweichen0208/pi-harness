// /restart、/reload 与显式扩展重载必须刷新所有形态的扩展代码（issue #64）：
// jiti 对原生 .js 走 Node import()/require()，进程内缓存会让 npm 包形式的
// 扩展在重启后仍是旧代码、旧状态（MCP 桥死连接就是这么留下的）。
// 覆盖：.ts 文件、npm CJS 包、npm ESM 包，以及连续两次刷新和 reload 路径。
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientSession } from "../dist/server/agent-service.js";
import { ClientStateStore } from "../dist/server/client-state.js";
import { ThinkingDurationStore } from "../dist/server/thinking-timing.js";

const root = mkdtempSync(join(tmpdir(), "pi-restart-ext-cache-"));
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
const agentDir = process.env.PI_CODING_AGENT_DIR;
mkdirSync(join(agentDir, "extensions"), { recursive: true });

const installTs = v => writeFileSync(join(agentDir, "extensions", "probe.ts"), `export default function(pi) {
	let calls = 0;
	pi.registerCommand("probets", { description: "probe", handler: async (_, ctx) => ctx.ui.notify("ts-${v}:" + (++calls), "info") });
}`);
const installPkg = (name, v, type) => {
	const dir = join(agentDir, "npm", "node_modules", name);
	mkdirSync(join(dir, "dist"), { recursive: true });
	writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0", type, main: "dist/index.js", pi: { extensions: ["./dist"] } }, null, "\t"));
	if (type === "module") {
		// ESM 形态：入口与子模块都走原生 import()，只能靠查询参数换 URL 破缓存。
		writeFileSync(join(dir, "dist/state.js"), `let calls = 0;\nexport const bump = () => ++calls;\nexport const version = "${v}";\n`);
		writeFileSync(join(dir, "dist/index.js"), `import { bump, version } from "./state.js";\nexport default function(pi){ pi.registerCommand("probe-${name}", { description: "probe", handler: async (_, ctx) => ctx.ui.notify("${name}-" + version + ":" + bump(), "info") }); }\n`);
	} else {
		// CJS 形态：靠清空 require.cache（含 dist/state.js 子模块）。
		writeFileSync(join(dir, "dist/state.js"), `let calls = 0; function bump(){ return ++calls; } module.exports = { bump, version: "${v}" };\n`);
		writeFileSync(join(dir, "dist/index.js"), `const { bump, version } = require("./state.js");\nmodule.exports = function(pi){ pi.registerCommand("probe-${name}", { description: "probe", handler: async (_, ctx) => ctx.ui.notify("${name}-" + version + ":" + bump(), "info") }); };\n`);
	}
};
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:cjspkg", "npm:esmpkg"] }, null, "\t"));

let cs;
try {
	installTs("v1"); installPkg("cjspkg", "v1"); installPkg("esmpkg", "v1", "module");
	cs = await ClientSession.create("restart-ext-cache", root, new ClientStateStore(join(root, "state.json")), new ThinkingDurationStore(join(root, "thinking.json")));
	const wire = []; cs.attachSink(m => wire.push(m));
	const notices = () => wire.filter(m => m.type === "notice").map(m => m.text);
	const probeAll = async () => { for (const cmd of ["/probets", "/probe-cjspkg", "/probe-esmpkg"]) await cs.prompt(cmd); };

	await probeAll();
	assert.deepEqual(notices(), ["ts-v1:1", "cjspkg-v1:1", "esmpkg-v1:1"], JSON.stringify(notices()));

	// /restart 后三种形态都必须是新代码、新状态（计数从 1 重新开始）。
	installTs("v2"); installPkg("cjspkg", "v2"); installPkg("esmpkg", "v2", "module");
	await cs.prompt("/restart", undefined, false, "restart-1");
	assert(wire.some(m => m.type === "prompt_result" && m.requestId === "restart-1" && m.ok));
	wire.length = 0;
	await probeAll();
	assert.deepEqual(notices(), ["ts-v2:1", "cjspkg-v2:1", "esmpkg-v2:1"], `首次 /restart 后仍是旧代码：${JSON.stringify(notices())}`);

	// 再刷一次：代数递增必须持续有效，不能只有第一次生效。
	installPkg("cjspkg", "v3"); installPkg("esmpkg", "v3", "module");
	await cs.restartSession(cs.conv.id);
	wire.length = 0;
	await probeAll();
	assert.deepEqual(notices(), ["ts-v2:1", "cjspkg-v3:1", "esmpkg-v3:1"], `二次重启后仍是旧代码：${JSON.stringify(notices())}`);

	// 设置/提示词/MCP 保存走的共用 session.reload() 不刷新模块缓存（每次刷新都会在
	// ESM 缓存里多留一份实例）；npm 包仍是旧代码。
	installPkg("cjspkg", "v4"); installPkg("esmpkg", "v4", "module");
	await cs.conv.session.reload();
	wire.length = 0;
	await probeAll();
	assert(!notices().some(n => n.includes("-v4")), `普通 session.reload() 不应刷新扩展模块：${JSON.stringify(notices())}`);

	// 显式扩展重载（extensions_reload：安装/更新/移除后）要拿到新代码。
	await cs.reloadExtensions();
	wire.length = 0;
	await probeAll();
	assert.deepEqual(notices(), ["ts-v2:1", "cjspkg-v4:1", "esmpkg-v4:1"], `reloadExtensions() 后仍是旧代码：${JSON.stringify(notices())}`);

	console.log("PASS /restart and reloadExtensions() refresh .ts, npm CJS, and npm ESM extension code (state resets with fresh modules)");
} finally {
	await cs?.dispose(); rmSync(root, { recursive: true, force: true });
}
