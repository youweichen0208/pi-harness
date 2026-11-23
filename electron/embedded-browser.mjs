import { WebContentsView, ipcMain } from "electron";
import { randomUUID } from "node:crypto";

// Runs in an isolated world. The caller supplies data, never executable source.
function pageAction(action, args, token) {
	const visible = el => el.checkVisibility() && el.getClientRects().length;
	if (action === "read") {
		const visibleElements = Array.from(document.querySelectorAll("a[href],button,input,select,textarea,[contenteditable=true],[role=button]"))
			.filter(visible);
		const elements = visibleElements.slice(0, 180);
		const text = document.body.innerText;
		const main = document.querySelector("main, [role=main]") || document.body;
		const intro = [];
		for (const el of main.querySelectorAll("h1, p")) {
			if (!visible(el)) continue;
			const line = el.innerText?.trim();
			if (line) intro.push(line.slice(0, 240));
			if (intro.length === 2) break;
		}
		globalThis.piBrowserElements = elements;
		globalThis.piBrowserSnapshot = token;
		return {
			title: document.title,
			url: location.origin + location.pathname,
			excerpt: intro.join(" · ").slice(0, 240),
			hasForm: document.forms.length > 0,
			textTruncated: text.length > 24000,
			elementsTruncated: visibleElements.length > elements.length,
			text: text.slice(0, 24000),
			elements: elements.map((el, index) => ({
				id: index + 1,
				role: el.getAttribute("role") || el.tagName.toLowerCase(),
				label: (el.getAttribute("aria-label") || el.labels?.[0]?.innerText || el.innerText || el.placeholder || el.title || "").slice(
					0,
					200,
				),
			})),
		};
	}
	if (args.snapshot !== globalThis.piBrowserSnapshot) throw Error("Page changed. Read again.");
	globalThis.piBrowserSnapshot = undefined;
	if (action === "scroll") {
		window.scrollBy(0, args.direction === "up" ? -innerHeight : innerHeight);
		return true;
	}
	const el = globalThis.piBrowserElements?.[args.element - 1];
	if (!el?.isConnected || !visible(el) || el.matches(":disabled")) throw Error("Element changed. Read the page again.");
	if (action === "click") {
		el.click();
		return true;
	}
	if (
		action === "fill" &&
		(el instanceof HTMLTextAreaElement ||
			(el instanceof HTMLInputElement && ["search", "text", "url", "email", "tel", "number"].includes(el.type))) &&
		!el.readOnly
	) {
		const prototype = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
		Object.getOwnPropertyDescriptor(prototype, "value").set.call(el, args.text);
		el.dispatchEvent(new Event("input", { bubbles: true }));
		el.dispatchEvent(new Event("change", { bubbles: true }));
		return true;
	}
	if (action === "fill" && el.isContentEditable) {
		el.focus();
		const range = document.createRange();
		range.selectNodeContents(el);
		const selection = window.getSelection();
		selection.removeAllRanges();
		selection.addRange(range);
		if (document.execCommand("insertText", false, args.text)) return true;
	}
	throw Error("Unsupported field.");
}

export function installEmbeddedBrowser(getWindow, getOrigin, getClient) {
	const tabs = new Map();
	let active, shown, bounds, owner, snapshot, attached;
	const current = () => tabs.get(active)?.webContents;
	const invalidate = () => {
		snapshot = undefined;
	};
	const state = () => ({
		active,
		owner,
		tabs: [...tabs].map(([id, view]) => ({
			id,
			title: view.webContents.getTitle(),
			url: view.webContents.getURL(),
			back: view.webContents.navigationHistory.canGoBack(),
			forward: view.webContents.navigationHistory.canGoForward(),
		})),
	});
	const publish = () => {
		const win = getWindow();
		if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("embedded-browser-state", state());
	};
	function layout() {
		const win = getWindow();
		const target =
			win && shown && bounds && current()?.getURL() && current().getURL() !== "about:blank" ? tabs.get(active) : undefined;
		if (attached !== target) {
			if (attached && win && !win.isDestroyed()) win.contentView.removeChildView(attached);
			attached = target;
			if (attached) win.contentView.addChildView(attached);
		}
		if (attached) attached.setBounds(bounds);
	}
	function url(value) {
		const u = new URL(value);
		if (!["https:", "http:"].includes(u.protocol) || u.username || u.password || u.origin === getOrigin())
			throw Error("Unsupported URL");
		return u.href;
	}
	function select(id) {
		if (!tabs.has(id)) throw Error("Tab closed");
		active = id;
		invalidate();
		layout();
		publish();
	}
	function add(options = {}) {
		const view = new WebContentsView({
			...options,
			webPreferences: {
				...options.webPreferences,
				preload: undefined,
				partition: "persist:pi-browser",
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});
		const wc = view.webContents;
		wc.session.setPermissionRequestHandler((_wc, _perm, reply) => reply(false));
		wc.session.setPermissionCheckHandler(() => false);
		const session = wc.session;
		session.webRequest.onBeforeRequest((details, reply) => {
			const u = new URL(details.url);
			reply({
				cancel:
					["http:", "https:", "ws:", "wss:"].includes(u.protocol) &&
					u.port === new URL(getOrigin()).port &&
					["localhost", "127.0.0.1", "[::1]"].includes(u.hostname),
			});
		});
		tabs.set(wc.id, view);
		wc.on("will-navigate", (event, target) => {
			try {
				url(target);
			} catch {
				event.preventDefault();
			}
		});
		wc.on("will-redirect", (event, target) => {
			try {
				url(target);
			} catch {
				event.preventDefault();
			}
		});
		wc.setWindowOpenHandler(({ url: target }) => {
			if (!shown || current() !== wc) return { action: "deny" };
			if (target && target !== "about:blank") {
				try {
					url(target);
				} catch {
					return { action: "deny" };
				}
			}
			return { action: "allow", createWindow: options => add(options) };
		});
		wc.on("did-start-navigation", () => {
			if (wc.id === active) invalidate();
		});
		for (const event of ["did-navigate", "did-navigate-in-page", "page-title-updated", "did-stop-loading"])
			wc.on(event, () => {
				if (event !== "page-title-updated") layout();
				publish();
			});
		const id = wc.id;
		wc.once("destroyed", () => {
			if (!tabs.delete(id) || active !== id) return;
			if (tabs.size) select([...tabs.keys()].pop());
			else {
				active = undefined;
				invalidate();
				layout();
				publish();
			}
		});
		select(id);
		return wc;
	}
	function hide() {
		shown = false;
		owner = undefined;
		invalidate();
		bounds = undefined;
		layout();
	}
	ipcMain.handle("embedded-browser", async (event, action, value) => {
		const win = getWindow();
		if (
			!win ||
			win.isDestroyed() ||
			event.sender !== win.webContents ||
			event.senderFrame !== win.webContents.mainFrame ||
			new URL(event.senderFrame.url).origin !== getOrigin()
		)
			throw Error("Unavailable");
		if (action === "open") {
			if (typeof value !== "string" || !value) throw Error("Missing browser conversation.");
			if (value !== owner) invalidate();
			owner = value;
			shown = true;
			if (!current()) add();
		} else if (action === "hide") hide();
		else if (shown) {
			const wc = current();
			switch (action) {
				case "bounds": {
					if (value) {
						const scale = win.webContents.getZoomFactor();
						bounds = {
							x: Math.round(value.x * scale),
							y: Math.round(value.y * scale),
							width: Math.round(value.width * scale),
							height: Math.round(value.height * scale),
						};
					} else {
						bounds = undefined;
						invalidate();
					}
					layout();
					break;
				}
				case "add":
					add();
					break;
				case "select":
					select(value);
					break;
				case "close": {
					const closed = tabs.get(value);
					if (!closed) break;
					tabs.delete(value);
					if (value === active) {
						if (tabs.size) select([...tabs.keys()].pop());
						else add();
					}
					closed.webContents.close();
					break;
				}
				case "go":
					await wc.loadURL(url(value));
					break;
				case "back":
					wc.navigationHistory.goBack();
					break;
				case "forward":
					wc.navigationHistory.goForward();
					break;
				case "reload":
					wc.reload();
					break;
			}
		}
		return state();
	});
	async function execute(msg) {
		const wc = current();
		if (!shown || !bounds || !owner || owner !== msg.owner || msg.client !== getClient() || !getWindow()?.isVisible() || !wc)
			throw Error("Browser control is inactive. Ask the user to open the Browser panel in this conversation, then retry.");
		const a = msg.args;
		if (a.action === "fill" && typeof a.text !== "string") throw Error("Missing input text.");
		if (wc.isLoadingMainFrame()) throw Error("Page is loading. Read again.");
		const blank = !wc.getURL() || wc.getURL() === "about:blank";
		if (!blank) url(wc.getURL());
		if (a.action !== "read" && (!snapshot || a.snapshot !== snapshot)) throw Error("Page changed. Read the active tab again.");
		const token = randomUUID();
		snapshot = token;
		if (a.action === "navigate") {
			await wc.loadURL(url(a.url));
			return "Navigated";
		}
		if (blank && a.action === "read") return { snapshot: token, text: "New tab", elements: [] };
		if (blank) throw Error("Navigate to a web page first.");
		const result = await wc.executeJavaScriptInIsolatedWorld(1001, [
			{
				code:
					"(" + pageAction.toString() + ")(" + JSON.stringify(a.action) + "," + JSON.stringify(a) + "," + JSON.stringify(token) + ")",
			},
		]);
		if (a.action === "read") {
			if (snapshot !== token || !shown || !bounds) throw Error("Page changed. Read again.");
			return { snapshot: token, ...result };
		}
		return "Done";
	}
	return {
		hide,
		reset() {
			hide();
			publish();
		},
		attach(child) {
			child.on("message", msg => {
				if (msg?.type !== "embedded-browser") return;
				const reply = body => {
					if (child.connected) child.send({ type: msg.type, id: msg.id, ...body }, () => {});
				};
				execute(msg).then(
					result => reply({ result }),
					err => reply({ error: err.message }),
				);
			});
		},
	};
}
