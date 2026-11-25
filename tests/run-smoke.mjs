#!/usr/bin/env node
/**
 * run-smoke.mjs — 零 token 协议冒烟测试聚合跑器（本地与 CI 共用）。
 *
 * 顺序执行一组自起 server 的 *-test.mjs 脚本（各自独立端口 + 临时 data-dir，
 * 结束时自行清理）。任何一个失败不中断后续，最后汇总并以非零码退出。
 *
 * 不收录的脚本及原因：
 *   - 浏览器 E2E（playwright/chromium，路径写死本机）：*-browser*、scm-test、
 *     freeze、goal-pill/ui/rounds、panel/left/sound/settings-ui 等 → 本地手动跑；
 *   - 真模型 live：goal-review-loop、live-test（需已运行 server）、update-test。
 *
 * 用法：node tests/run-smoke.mjs [name1 name2 …]   # 无参 = 全量
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { acquireSmokeLock, parseSmokeArgs, runSmokeTest } from "./lib/smoke-runner.mjs";

const here = dirname(fileURLToPath(import.meta.url));

// Windows 本机已知失败（非逻辑问题，ubuntu CI 正常）：
//   - terminal-smoke-test：node-pty 在 ConPTY 下 shell 退出事件/控制台列表 agent
//     （AttachConsole failed）行为差异，导致退出检测类检查超时；
//   - restart-handoff-test：所有断言通过后 libuv 在命名管道关闭时触发
//     win\\async.c 断言崩溃（退出码 127），属 libuv 关闭时序问题。
const WIN32_KNOWN_ENV_FAIL = new Set(["terminal-smoke-test", "restart-handoff-test"]);

const ALL = [
	"test-env-test",
	"smoke-runner-test",
	"isolated-server-test",
	"notes-test",
	"playground-test",
	"playground-methods-test",
	"playground-python-tools-test",
	"project-workspaces-test",
	"project-new-chat-test",
	"shared-workspaces-test",
	"builtin-extensions-test",
	"knowledge-engine-test",
	"knowledge-queue-test",
	"knowledge-investigate-test",
	"context-corpus-test",
	"context-eval-test",
	"context-session-test",
	"context-pi-model-test",
	"app-updater-test",
	"desktop-server-auth-test",
	"client-eviction-test",
	"ws-malformed-test",
	"security-headers-test",
	"token-env-leak-test",
	"force-reset-session-test",
	"pi-native-review-repro",
	"long-history-cache-test",
	"long-history-browser-test",
	"changes-panel-ui-test",
	"tool-text-continue-test",
	"run-recovery-test",
	"execution-trace-test",
	"clear-provider-key-test",
	"provider-catalog-test",
	"component-updates-test",
	"extensions-test",
	"extensions-worker-test",
	"extension-ui-test",
	"delegate-notification-test",
	"session-tree-test",
	"tool-output-test",
	"recovery-service-test",
	"gateway-error-test",
	"output-limit-context-test",
	"restart-session-test",
	"restart-extension-cache-test",
	"system-prompt-test",
	"conv-cwd-test",
	"fetch-models-test",
	"global-search-test",
	"global-search-ui-test",
	"code-search-ui-test",
	"file-editor-protocol-test",
	"prompt-receipts-test",
	"wiki-protocol-test",
	"wiki-assistant-test",
	"wiki-thinking-level-test",
	"wiki-bootstrap-model-test",
	"stale-model-selection-test",
	"wiki-modal-browser-test",
	"wiki-format-editor-test",
	"wiki-math-browser-test",
	"claude-source-vision-test",
	"wiki-insert-position-test",
	"current-file-protocol-test",
	"left-panel-delete-test",
	"plugin-cwd-test",
	"plugin-http-test",
	"native-tools-desktop-test",
	"pi-104-prompt-contract-test",
	"pi-104-upstream-fixes-test",
	"pi-140-sdk-test",
	"pi-150-sdk-test",
	"pi-152-sdk-test",
	"pi-160-sdk-test",
	"session-export-protocol-test",
	"pi152-model-compat-test",
	"cache-warming-test",
	"extension-diagnostics-test",
	"codemode-mcp-test",
	"provider-auth-test",
	"openai-proxy-test",
	"model-config-preservation-test",
	"model-sources-test",
	"model-sources-protocol-test",
	"node-workbench-test",
	"node-agent-test",
	"node-terminal-pty-test",
	"chat-redesign-ui-test",
	"plugin-settings-test",
	"plugin-test",
	"plugin-update-test",
	"preview-test",
	"quiesce-test",
	"recursive-watch-test",
	"refresh-models-test",
	"restart-handoff-test",
	"native-session-commands-test",
	"scm-features-test",
	"settings-test",
	"slash-commands-test",
	"snapshot-delta-test",
	"ssh-plugin-test",
	"steer-queue-smoke",
	"delete-session-terminal-test",
	"switch-session-background-test",
	"terminal-smoke-test",
	"version-handshake-test",
	"vscode-editor-plugin-test",
];

// 不在默认清单里的脚本：
//   - 旧 Wiki 独立会话/输入胶囊：wiki-ui-test；由 wiki-modal-browser-test
//     覆盖原会话、聊天停靠、保存、选区引用、焦点与小屏新交互。
//   - 需外部已运行 server（attach 型，默认 8787）：ws-session-test /
//     file-upload-test / image-paste-test / commands-test(8791) /
//     edit-reask-test / projects-test —— 本地先起 server 再单独跑；
//   - 需真模型（本地可跑，CI 无凭据必败）：goal-abort-test /
//     goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test /
//     tool-status-test（需真模型执行 bash 工具，从仓库根或任意目录均可跑）；
//   - 平台相关：spawn-helper-test（macOS spawn-helper 二进制）；win32 下
//     terminal-smoke / restart-handoff 自动跳过（见 WIN32_KNOWN_ENV_FAIL）；
//   - title-jsonl-test：已修复（原 lsof/URL.pathname 的 Windows 兼容问题），本地可跑；
//   - 浏览器 E2E 见文件头注释（headless Chrome 路径写死本机）。

async function main() {
	const { targets, defaultSelection, timeoutMs } = parseSmokeArgs(process.argv.slice(2), ALL);
	const release = await acquireSmokeLock(dirname(here));
	const controller = new AbortController();
	let interruptedCode = 0;
	const interrupt = signal => { interruptedCode ||= signal === "SIGINT" ? 130 : 143; controller.abort(); };
	const onInt = () => interrupt("SIGINT"), onTerm = () => interrupt("SIGTERM");
	process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
	const results = [];
	try {
		for (const [index, name] of targets.entries()) {
			if (controller.signal.aborted) break;
			const label = `[${index + 1}/${targets.length}] ${name}`;
			if (process.platform === "win32" && WIN32_KNOWN_ENV_FAIL.has(name) && defaultSelection) {
				results.push({ name, status: "skipped", durationMs: 0 });
				console.log(`${label} skipped — Windows known environment issue`);
				continue;
			}
			console.log(`\n▶ ${label}`);
			const result = await runSmokeTest({ file: join(here, `${name}.mjs`), cwd: dirname(here), timeoutMs, signal: controller.signal, label });
			results.push({ name, ...result });
			console.log(`${label} ${result.status} · ${(result.durationMs / 1000).toFixed(1)}s`);
		}
		console.log("\n===== 冒烟汇总 =====");
		for (const result of results) console.log(`${result.status === "passed" ? "✓" : result.status === "skipped" ? "⏭" : "✗"} ${result.name} — ${result.status} · ${(result.durationMs / 1000).toFixed(1)}s`);
		const count = status => results.filter(result => result.status === status).length;
		console.log(`\n${count("passed")} passed, ${count("failed")} failed, ${count("timeout")} timed out, ${count("skipped")} skipped, ${count("interrupted")} interrupted; ${results.length}/${targets.length} processed`);
		return interruptedCode || (results.some(result => !["passed", "skipped"].includes(result.status)) ? 1 : 0);
	} finally {
		process.removeListener("SIGINT", onInt); process.removeListener("SIGTERM", onTerm);
		await release();
	}
}
try { process.exitCode = await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
