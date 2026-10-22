import { createAppUpdater } from "./app-updater.mjs";
/**
 * pi-harness Electron 桌面版主进程。
 *
 * 架构：
 *   - 主进程 fork 一个隐藏子进程跑 server（ELECTRON_RUN_AS_NODE=1），
 *     server 使用 Electron 内置的 Node 运行时，node-pty 等原生模块
 *     在 electron-builder 打包时自动 rebuild 为 Electron ABI。
 *   - BrowserWindow 加载 http://127.0.0.1:{PORT}（server 就绪后）。
 *   - 托盘：关闭窗口 → 最小化到托盘；Quit → 真正退出（杀 server 子进程）。
 *   - 自动更新：electron-updater + GitHub Releases；设置页发起下载，用户确认后重启安装。
 *
 * 开发模式（npm run dev:electron）：
 *   先构建 web + server（npm run build），然后 electron . 即可。
 *   如有 Vite dev server (:5173)，优先加载它获取 HMR。
 *
 * 与当前 server/index.ts 的耦合点（重构时请对照检查）：
 *   - 就绪标记：server 启动后 stdout 打印 "⚡ pi-harness"（见 server/index.ts
 *     httpServer.listen 回调），本文件靠这行判断 server 已就绪。
 *   - PI_WEB_PKG_ROOT：告诉 server 去哪找 web/dist（resolvePkgRoot()），
 *     打包后指向 process.resourcesPath（electron-builder extraResources）。
 *   - PI_WEB_DATA_DIR：桌面版单独用 <home>/.pi-web-desktop，与命令行版
 *     的 <home>/.pi-web 分开，避免两边同时跑互相抢 client-state.json /
 *     terminals 等运行时状态（数据都在 SDK 的 ~/.pi/agent 里，两边共享，
 *     不受影响）。
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, dialog, ipcMain, shell } from "electron";
import { randomUUID } from "node:crypto";
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopClientId } from "./client-identity.mjs";
import { agentRuntimeEnvironment } from "./agent-runtime-env.mjs";
import { bearerHeaders, desktopServerToken, desktopWindowUrl } from "./server-auth.mjs";
// electron-updater 是 CJS 包，Node ESM 下不能直接 named import，
// 得走默认导出再解构（Node 的 CJS→ESM 互操作不会自动分析 named exports）。
import electronUpdaterPkg from "electron-updater";
const { autoUpdater } = electronUpdaterPkg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const isDev = !app.isPackaged || !!process.env.DEV;

// ── 状态 ──
/** @type {BrowserWindow | null} */
let mainWindow = null;
/** Wiki 独立窗口（ADR-0003）：同一时刻只保留一个，重复进入导航到它。 */
/** @type {BrowserWindow | null} */
let wikiWindow = null;
const assistantWindows = new Map();
/** 全部 app 窗口（主窗口 + wiki 窗口），IPC 归属校验用。 */
/** @type {Set<BrowserWindow>} */
const windows = new Set();
// macOS animates into page fullscreen; leaving before enter-full-screen strands the page in fullscreen (#89).
/** @type {Map<BrowserWindow, boolean>} */
const fullscreenSettling = new Map();
/** 每窗口的关闭守卫握手状态（pi-window-close-ready / -result）。 */
/** @type {Map<BrowserWindow, { ready: boolean; approved: boolean; pending: { id: string; timer: NodeJS.Timeout } | null }>} */
const closeGuards = new Map();
/** @type {Tray | null} */
let tray = null;
/** @type {import("node:child_process").ChildProcess | null} */
let serverProcess = null;
let isQuitting = false;
let serverPort = 0;
// One secret per launch, kept across server restarts so the open window stays authorized.
const serverToken = desktopServerToken();
let clientId;
const dataDir = process.env.PI_WEB_DATA_DIR || join(
	process.env.HOME || process.env.USERPROFILE || "~", ".pi-web-desktop",
);

// ── 路径 ──

// asar 关掉之后（见 electron-builder.yml 里的长注释），打包后的目录结构跟开发
// 时是同构的：__dirname 是 <app>/electron，ROOT 就是 <app>——开发时是仓库根，
// 打包后是 Resources/app。dist / web/dist / node_modules 全都平铺
// 在 ROOT 下面，所以这两个函数不再需要分打包和开发两种情况。

/** server 入口：<root>/dist/server/index.js */
function getServerPath() {
	return join(ROOT, "dist", "server", "index.js");
}

/** server 找 web/dist 的根目录 */
function getPkgRoot() {
	return ROOT;
}

// ── 端口 ──

/** 找一个随机空闲端口（防止端口冲突） */
async function findFreePort() {
	return new Promise((resolve, reject) => {
		const srv = createServer();
		srv.listen(0, "127.0.0.1", () => {
			const port = /** @type {import("node:net").AddressInfo} */ (srv.address()).port;
			srv.close(() => resolve(port));
		});
		srv.on("error", reject);
	});
}

// ── 启动 Server 子进程 ──

async function startServer(reusePort) {
	serverPort = reusePort || await findFreePort();
	const serverPath = getServerPath();

	if (!existsSync(serverPath)) {
		dialog.showErrorBox(
			"pi 启动失败",
			`找不到 server 入口：${serverPath}\n\n请先执行 npm run build，然后重试。`,
		);
		app.quit();
		return;
	}

	// 桌面版数据目录与命令行版分开（见文件头注释），确保存在
	mkdirSync(dataDir, { recursive: true, mode: 0o700 });

	serverProcess = fork(serverPath, [], {
		env: {
			...agentRuntimeEnvironment(getPkgRoot(), dataDir),
			PORT: String(serverPort),
			PI_WEB_HOST: "127.0.0.1",
			PI_WEB_TOKEN: serverToken,
			PI_WEB_DATA_DIR: dataDir,
			// Workspace 列表与命令行版共用 ~/.pi-web 里的同一份；测试指定数据目录时保持隔离
			...(process.env.PI_WEB_DATA_DIR ? {} : { PI_WEB_WORKSPACES_FILE: join(process.env.HOME || process.env.USERPROFILE || "~", ".pi-web", "project-workspaces.json") }),
			PI_WEB_NO_BROWSER: "1", // 不要自动打开浏览器（本身也不会打开，桌面版有自己的窗口）
			PI_WEB_PKG_ROOT: getPkgRoot(), // 告诉 server 去哪找 web/dist
			ELECTRON_RUN_AS_NODE: "1", // 以 Node.js 模式运行（非 Electron）
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
		serialization: "json",
	});

	// 收集 stdout/stderr 用于调试
	let serverOut = "";
	serverProcess.stdout?.on("data", (chunk) => {
		const text = chunk.toString();
		serverOut = (serverOut + text).slice(-64 * 1024);
		process.stdout.write(`[server] ${text}`);
	});
	serverProcess.stderr?.on("data", (chunk) => {
		const text = chunk.toString();
		serverOut = (serverOut + text).slice(-64 * 1024);
		process.stderr.write(`[server:err] ${text}`);
	});

	// 等待 server 就绪：监听 stdout 中的 "⚡ pi-harness" 标记（见 server/index.ts）
	await new Promise((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => {
			rejectPromise(
				new Error(`Server 启动超时（30s）。最后输出：\n${serverOut.slice(-500)}`),
			);
		}, 30_000);

		const checkOutput = (chunk) => {
			const text = chunk.toString();
			if (text.includes("⚡ pi-harness") || text.includes("http://localhost")) {
				clearTimeout(timeout);
				serverProcess.stdout?.removeListener("data", checkOutput);
				resolvePromise(undefined);
			}
		};

		serverProcess.stdout?.on("data", checkOutput);
		serverProcess.on("error", (err) => {
			clearTimeout(timeout);
			rejectPromise(err);
		});
		serverProcess.on("exit", (code) => {
			clearTimeout(timeout);
			if (code !== 0) {
				// 把 server 自己最后的输出带上。只报一个 exit code=1 的话，用户在
				// 弹窗里看到的就只有「启动失败」四个字，真正的原因（模块缺失、
				// 端口被占、配置读不了）全留在没人看得到的 stdout 里——超时那条
				// 分支早就是这么做的，退出这条漏了。
				const tail = serverOut.trim().slice(-800);
				rejectPromise(
					new Error(
						`Server 退出了 (exit code=${code})` +
							(tail ? `\n\n最后输出：\n${tail}` : ""),
					),
				);
			}
		});
	});

	console.log(`[electron] server 就绪，端口 ${serverPort}`);
}

/** Keep the window's URL stable so its WebSocket can reconnect after a crash. */
function watchServerExit() {
	const child = serverProcess;
	child?.once("exit", () => {
		if (isQuitting || serverProcess !== child) return;
		serverProcess = null;
		void recoverServer();
	});
}

async function recoverServer() {
	const port = serverPort;
	let lastError;
	for (const delay of [1000, 2000, 4000]) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
		if (isQuitting) return;
		try {
			await startServer(port);
			watchServerExit();
			return;
		} catch (error) {
			lastError = error;
			// A failed startup can leave a child alive until its own timeout fires.
			serverProcess?.kill("SIGTERM");
			serverProcess = null;
		}
	}
	if (!isQuitting) dialog.showErrorBox(
		"pi 服务已断开",
		`服务重启失败，请重新打开应用。\n\n${lastError instanceof Error ? lastError.message : String(lastError)}`,
	);
}

// ── 窗口 ──

const serverOrigin = () => `http://127.0.0.1:${serverPort}`;

/** 同源且带 ?wiki-window=1 的 URL = Wiki 独立窗口请求（ADR-0003）。 */
function isWikiWindowUrl(target) {
	try {
		const parsed = new URL(target);
		return parsed.origin === serverOrigin() && parsed.searchParams.get("wiki-window") === "1";
	} catch {
		return false;
	}
}

// Web links belong in the system browser, never a new privileged app window.
function openExternal(target) {
	try {
		const parsed = new URL(target);
		if (!["http:", "https:"].includes(parsed.protocol)) return;
		void shell.openExternal(parsed.href).catch(error => console.error("Unable to open browser:", error.message));
	} catch { /* Invalid navigation targets are blocked. */ }
}

/** 窗口外壳选项：主窗口与 Wiki 窗口共用（无边框 + 沙箱 preload）。 */
function windowShellOptions(overrides = {}) {
	return {
		width: 1200,
		height: 800,
		minWidth: 800,
		minHeight: 600,
		title: "pi-harness",
		backgroundColor: "#FFFFFF",
		show: false,
		...(process.platform === "darwin"
			? { titleBarStyle: "hidden", trafficLightPosition: { x: 18, y: 17 } }
			: { frame: false }),
		webPreferences: {
			preload: join(__dirname, "preload.cjs"),
			nodeIntegration: false,
			contextIsolation: true,
			additionalArguments: [`--pi-desktop-client-id=${clientId}`],
		},
		icon: join(ROOT, "web", "dist", "apple-touch-icon.png"),
		...overrides,
	};
}

/**
 * 每个 app 窗口的公共接线：窗口状态发布、外链拦截、导航守卫、未保存离开确认、
 * 关闭守卫。hideOnClose=true（主窗口）关闭时隐藏到托盘；false（Wiki 窗口）真正关闭。
 */
function wireAppWindow(win, { hideOnClose }) {
	windows.add(win);
	closeGuards.set(win, { ready: false, approved: false, pending: null });

	const publishWindowState = () => {
		if (!win.isDestroyed()) win.webContents.send("pi-window-state", windowState(win));
	};
	// An already fullscreen window has no transition to wait for.
	win.on("enter-html-full-screen", () => { fullscreenSettling.set(win, !win.isFullScreen()); });
	for (const event of ["enter-full-screen", "leave-full-screen"]) win.on(event, () => { fullscreenSettling.set(win, false); });
	for (const event of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen", "enter-html-full-screen", "leave-html-full-screen", "restore"]) {
		win.on(event, publishWindowState);
	}
	win.webContents.on("did-finish-load", publishWindowState);
	win.webContents.on("will-prevent-unload", (event) => {
		const zh = app.getLocale().startsWith("zh");
		const choice = dialog.showMessageBoxSync(win, {
			type: "warning",
			message: zh ? "文件有未保存的修改，确定放弃并离开？" : "Discard unsaved file changes and leave?",
			buttons: zh ? ["取消", "放弃修改"] : ["Cancel", "Discard changes"],
			defaultId: 0,
			cancelId: 0,
		});
		// Electron allows unloading only when this event is prevented.
		if (choice === 1) event.preventDefault();
		else isQuitting = false;
	});

	win.webContents.setWindowOpenHandler(({ url: target, frameName }) => {
		if (win === wikiWindow && target === "about:blank" && frameName === "pi-wiki-assistant") {
			return { action: "allow", overrideBrowserWindowOptions: {
				width: 375, height: 820, minWidth: 360, minHeight: 420,
				// Do not inherit the Wiki opener's fullscreen Space on macOS.
				fullscreen: false, fullscreenable: false,
				frame: false, title: "问 pi", autoHideMenuBar: true,
				webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
			} };
		}

		if (isWikiWindowUrl(target)) {
			openWikiAppWindow(target);
			return { action: "deny" };
		}
		openExternal(target);
		return { action: "deny" };
	});
	win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
		if (mainFrame && !inPlace) {
			const child = assistantWindows.get(win);
			if (child && !child.isDestroyed()) child.destroy();
		}
	});
	win.webContents.on("did-create-window", child => {
		// The blank assistant only hosts DOM owned by its Wiki opener.
		assistantWindows.set(win, child);
		child.on("close", event => {
			if (!win.isDestroyed() && !isQuitting) { event.preventDefault(); child.hide(); win.webContents.send("pi-assistant-hidden"); }
		});
		child.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: "deny" }; });
		child.webContents.on("will-navigate", event => event.preventDefault());
		const dispose = () => { if (!child.isDestroyed()) child.destroy(); };
		win.once("closed", dispose);
		child.once("closed", () => { assistantWindows.delete(win); win.removeListener("closed", dispose); });
	});
	const guardNavigation = (event, target) => {
		try { if (new URL(target).origin === serverOrigin()) return; } catch { /* fall through */ }
		event.preventDefault();
		openExternal(target);
	};
	win.webContents.on("will-navigate", guardNavigation);
	win.webContents.on("will-redirect", guardNavigation);

	// Give the editor a chance to flush before hiding or quitting. Keep the server
	// alive until the matching main-frame acknowledgement; failure cancels closing.
	win.on("close", (event) => {
		const guard = closeGuards.get(win);
		if (guard?.ready && !guard.approved) {
			event.preventDefault();
			if (!guard.pending) {
				const id = randomUUID();
				guard.pending = { id, timer: setTimeout(() => { guard.pending = null; isQuitting = false; win.show(); }, 30000) };
				win.webContents.send("pi-window-before-close", id);
			}
			return;
		}
		if (guard) guard.approved = false;
		if (hideOnClose && !isQuitting) {
			event.preventDefault();
			win.hide();
		}
	});

	win.on("closed", () => {
		windows.delete(win);
		const guard = closeGuards.get(win);
		if (guard?.pending) clearTimeout(guard.pending.timer);
		closeGuards.delete(win);
		fullscreenSettling.delete(win);
		if (win === mainWindow) mainWindow = null;
		if (win === wikiWindow) wikiWindow = null;
	});
}

function createWindow() {
	mainWindow = new BrowserWindow(windowShellOptions());
	wireAppWindow(mainWindow, { hideOnClose: true });
	// 加载 localhost 上的 server
	mainWindow.loadURL(desktopWindowUrl(serverPort, serverToken));

	mainWindow.once("ready-to-show", () => {
		mainWindow.show();
	});

	// 开发模式打开 DevTools
	if (isDev) {
		mainWindow.webContents.openDevTools({ mode: "detach" });
	}
}

/**
 * Wiki 独立窗口（ADR-0003）：渲染进程 window.open 一个 ?wiki-window=1 的同源
 * URL 时由这里创建/复用。同一时刻只有一个 Wiki 窗口，重复进入导航到新文档并聚焦。
 */
function openWikiAppWindow(url) {
	if (wikiWindow && !wikiWindow.isDestroyed()) {
		void wikiWindow.loadURL(url);
		wikiWindow.show();
		wikiWindow.focus();
		return;
	}
	wikiWindow = new BrowserWindow(windowShellOptions({
		width: 1100,
		height: 800,
		minWidth: 720,
		minHeight: 480,
		title: "pi wiki",
	}));
	wireAppWindow(wikiWindow, { hideOnClose: false });
	void wikiWindow.loadURL(url);
	wikiWindow.once("ready-to-show", () => {
		wikiWindow?.show();
	});
}

/** Resolve the app window that sent an IPC event; foreign webContents get nothing. */
function windowOf(event) {
	const win = BrowserWindow.fromWebContents(event.sender);
	return win && windows.has(win) ? win : null;
}

ipcMain.handle("pi-assistant-visibility", (event, visible) => {
	const owner = windowOf(event);
	if (!owner || event.senderFrame !== owner.webContents.mainFrame) return;
	const child = assistantWindows.get(owner);
	if (!child || child.isDestroyed()) return;
	if (visible === true) { child.show(); child.focus(); } else child.hide();
});

ipcMain.on("pi-window-close-ready", (event, ready) => {
	const win = windowOf(event);
	const guard = win && closeGuards.get(win);
	if (guard && event.senderFrame === win.webContents.mainFrame) guard.ready = ready === true;
});
ipcMain.on("pi-window-close-result", (event, result) => {
	const win = windowOf(event);
	if (!win || event.senderFrame !== win.webContents.mainFrame) return;
	const guard = closeGuards.get(win);
	if (!guard?.pending || result?.id !== guard.pending.id) return;
	clearTimeout(guard.pending.timer); guard.pending = null;
	if (result.allow !== true) { isQuitting = false; win.show(); win.focus(); return; }
	guard.approved = true;
	if (isQuitting) app.quit(); else win.close();
});

// Only the app's own windows may control themselves. The renderer receives
// fixed operations, never an arbitrary Electron method or channel.
ipcMain.handle("pi-window-action", (event, action) => {
	const win = windowOf(event);
	if (!win || win.isDestroyed()) return;
	switch (action) {
		case "minimize": win.minimize(); break;
		case "toggle-maximize":
			if (win.isFullScreen()) win.setFullScreen(false);
			else if (win.isMaximized()) win.unmaximize();
			else win.maximize();
			break;
		case "close": win.close(); break;
	}
});
// The renderer supplies workspace identity, never an arbitrary executable path.
// Ask our authenticated server to resolve the active workspace's file first.
ipcMain.handle("pi-wiki-open-file", async (event, request) => {
	const win = windowOf(event);
	if (!win || win.isDestroyed() || event.senderFrame !== win.webContents.mainFrame) throw new Error("Forbidden");
	if (!request || ![request.clientId, request.cwd, request.path].every(value => typeof value === "string")) throw new Error("Invalid file request");
	const response = await fetch(`http://127.0.0.1:${serverPort}/api/wiki`, {
		method: "POST", headers: { "Content-Type": "application/json", ...bearerHeaders(serverToken) },
		body: JSON.stringify({ clientId: request.clientId, cwd: request.cwd, path: request.path, action: "open-info" }),
	});
	const result = await response.json();
	if (!response.ok || typeof result.absolute !== "string") throw new Error(result.error || "Unable to open file");
	const error = await shell.openPath(result.absolute);
	if (error) throw new Error(error);
});
ipcMain.handle("pi-extension-open-path", async (event, request) => {
	const win = windowOf(event);
	if (!win || win.isDestroyed() || event.senderFrame !== win.webContents.mainFrame) throw new Error("Forbidden");
	if (!request || ![request.clientId, request.cwd, request.id].every(value => typeof value === "string")) throw new Error("Invalid package request");
	const response = await fetch(`http://127.0.0.1:${serverPort}/api/extensions`, {
		method: "POST", headers: { "Content-Type": "application/json", ...bearerHeaders(serverToken) },
		body: JSON.stringify({ clientId: request.clientId, cwd: request.cwd, id: request.id, action: "open-info" }),
	});
	const result = await response.json();
	if (!response.ok || typeof result.absolute !== "string") throw new Error(result.error || "Installed path unavailable");
	shell.showItemInFolder(result.absolute);
});
ipcMain.handle("pi-window-state-read", (event) => {
	const win = windowOf(event);
	if (!win || win.isDestroyed()) return null;
	return windowState(win);
});
function windowState(win) {
	return { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), fullscreenSettling: fullscreenSettling.get(win) ?? false };
}

// ── 托盘 ──

function createTray() {
	const iconPath = join(ROOT, "web", "dist", "apple-touch-icon.png");
	const icon = existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
	tray = new Tray(icon.isEmpty() ? icon : icon.resize({ width: 16, height: 16 }));
	tray.setToolTip("pi");

	const contextMenu = Menu.buildFromTemplate([
		{
			label: "显示窗口",
			click: () => {
				if (mainWindow) {
					mainWindow.show();
					mainWindow.focus();
				}
			},
		},
		{ type: "separator" },
		{
			label: "关于 pi",
			click: () => {
				dialog.showMessageBox({
					type: "info",
					title: "关于 pi",
					message: `pi v${app.getVersion()}`,
					detail: "Web chat interface for the pi coding agent.",
				});
			},
		},
		{ type: "separator" },
		{
			label: "退出",
			click: () => {
				isQuitting = true;
				app.quit();
			},
		},
	]);

	tray.setContextMenu(contextMenu);

	// 点击托盘图标 → 显示/隐藏窗口
	tray.on("click", () => {
		if (mainWindow) {
			if (mainWindow.isVisible()) {
				mainWindow.hide();
			} else {
				mainWindow.show();
				mainWindow.focus();
			}
		}
	});
}

// ── 菜单 ──

function createAppMenu() {
	const template = [
		{
			label: "pi",
			submenu: [
				{
					label: "关于 pi",
					click: () => {
						dialog.showMessageBox({
							type: "info",
							title: "关于 pi",
							message: `pi v${app.getVersion()}`,
							detail: "Web chat interface for the pi coding agent.",
						});
					},
				},
				{ type: "separator" },
				{ role: "hide" },
				{ role: "hideOthers" },
				{ role: "unhide" },
				{ type: "separator" },
				{
					label: "退出",
					accelerator: "CmdOrCtrl+Q",
					click: () => {
						isQuitting = true;
						app.quit();
					},
				},
			],
		},
		{
			label: "编辑",
			submenu: [
				{ role: "undo" },
				{ role: "redo" },
				{ type: "separator" },
				{ role: "cut" },
				{ role: "copy" },
				{ role: "paste" },
				{ role: "selectAll" },
			],
		},
		{
			label: "视图",
			submenu: [
				{ role: "reload" },
				{ role: "forceReload" },
				{ role: "toggleDevTools" },
				{ type: "separator" },
				{ role: "resetZoom" },
				{ role: "zoomIn" },
				{ role: "zoomOut" },
				{ type: "separator" },
				{ role: "togglefullscreen" },
			],
		},
		{
			label: "窗口",
			submenu: [{ role: "minimize" }, { role: "close" }],
		},
	];

	// macOS 需要第一个菜单项是应用名
	const menu = Menu.buildFromTemplate(template);
	Menu.setApplicationMenu(menu);
}

// ── 自动更新 ──

function setupAutoUpdater() {
	const appUpdater = createAppUpdater({
		updater: autoUpdater, version: app.getVersion(), supported: !isDev,
		publish: state => {
			if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("pi-app-update-state", state);
		},
		confirmInstall: async () => {
			if (!mainWindow || mainWindow.isDestroyed()) return false;
			const zh = app.getLocale().startsWith("zh");
			const result = await dialog.showMessageBox(mainWindow, {
				type: "question",
				message: zh ? "重启应用并安装更新？请先保存正在编辑的文件。" : "Restart to install the update? Save your open files first.",
				buttons: zh ? ["稍后", "重启并安装"] : ["Later", "Restart and install"], defaultId: 0, cancelId: 0,
			});
			return result.response === 1;
		},
	});
	ipcMain.handle("pi-app-update", (event, action) => {
		const win = windowOf(event);
		if (!win || win.isDestroyed() || event.senderFrame !== win.webContents.mainFrame) throw Error("Forbidden");
		return appUpdater.run(action);
	});
	if (!isDev) setTimeout(() => void appUpdater.run("check"), 5000);
}

// ── 应用生命周期 ──

app.setAppUserModelId("com.youweichen.pi-harness");

// 确保只有一个实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
	app.quit();
} else {
	app.on("second-instance", () => {
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			mainWindow.show();
			mainWindow.focus();
		}
	});
}

app.whenReady().then(async () => {
	try {
		clientId = desktopClientId(dataDir);
		await startServer();
		watchServerExit();
	} catch (err) {
		dialog.showErrorBox("pi 启动失败", err instanceof Error ? err.message : String(err));
		app.quit();
		return;
	}

	createAppMenu();
	createWindow();
	createTray();
	setupAutoUpdater();

	app.on("activate", () => {
		if (!mainWindow) createWindow();
		if (mainWindow) {
			mainWindow.show();
			mainWindow.focus();
		}
	});
});

app.on("window-all-closed", () => {
	// macOS 不退出（dock 图标还在）
	// 其他平台退出
	if (process.platform !== "darwin") {
		isQuitting = true;
		app.quit();
	}
});

app.on("before-quit", () => {
	isQuitting = true;
});

app.on("will-quit", () => {
	// 杀 server 子进程
	if (serverProcess) {
		try {
			serverProcess.kill("SIGTERM");
		} catch {
			// 可能已经退出
		}
		serverProcess = null;
	}
	if (tray) {
		tray.destroy();
		tray = null;
	}
});
