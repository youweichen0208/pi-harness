import { WebContentsView, ipcMain, nativeImage } from "electron";
import { randomUUID } from "node:crypto";

// Runs in an isolated world. The caller supplies data, never executable source.
function pageAction(action, args, token) {
	const visible = el => el.checkVisibility() && el.getClientRects().length;
	if (action === "find") {
		const body = document.body.innerText;
		const matches = [];
		const query = args.text?.trim();
		if (!query) throw Error("Provide text to find.");
		const haystack = body.toLowerCase(), needle = query.toLowerCase();
		for (let i = haystack.indexOf(needle); i >= 0 && matches.length < 20; i = haystack.indexOf(needle, i + needle.length))
			matches.push(body.slice(Math.max(0, i - 120), i + needle.length + 120));
		return { matches };
	}
	if (action === "read") {
		const visibleElements = Array.from(document.querySelectorAll("a[href],summary,button,input,select,textarea,[contenteditable=true],[role=button]"))
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
	function describe(el) {
		if (!el) return { label: "?", confirm: true };
		if (!el.isConnected || !visible(el)) throw Error("Element changed. Read again.");
		const buttonValue = el.matches("input[type=button],input[type=submit]") ? el.value : "";
		const label = (el.innerText || el.getAttribute("aria-label") || buttonValue || el.getAttribute("placeholder") || el.title || el.tagName).trim().slice(0, 160);
		const navigation = el.matches("a[href]") && /^https?:$/.test(el.protocol) && !el.matches("[download],[onclick],[role=button]") && el.getAttribute("href") !== "#";
		const browse = /^(search|next|previous|more|expand|搜索|查询|下一页|上一页|展开|加载更多)$/i.test(label);
		const consequential = /submit|send|delete|remove|purchase|order now|confirm|save|提交|发送|删除|购买|下单|确认|保存/i.test(label + " " + (el.getAttribute("href") || ""));
		const input = el.matches("textarea,input[type=text],input[type=search],input:not([type]),[contenteditable=true]");
		return { label, href: el.href, confirm: consequential || (!input && !navigation && !browse && !el.matches("summary,[aria-expanded]")) };
	}
	function controlState(el) {
		const fields = Array.from(el?.form?.elements || []);
		return JSON.stringify(fields.map(field => [field.name, field.value, field.checked, field.disabled]));
	}
	if (action === "rememberFocus") {
		const element = document.activeElement;
		globalThis.piBrowserFocus = { element, fields: controlState(element) };
		return element?.getAttribute("aria-label") || element?.getAttribute("name") || element?.tagName || "";
	}
	if (action === "checkFocus") {
		const saved = globalThis.piBrowserFocus;
		return saved?.element === document.activeElement && saved.fields === controlState(saved.element);
	}
	if (action === "inspectPoint" || action === "checkPoint") {
		const node = document.elementFromPoint(args.fractionX * innerWidth, args.fractionY * innerHeight);
		const element = node?.closest("a[href],button,summary,[role=button],input,textarea,[aria-expanded]") || node;
		if (action === "checkPoint") {
			const saved = globalThis.piBrowserPoint;
			return saved?.element === element && saved.fields === controlState(element) && saved.description === JSON.stringify(describe(element));
		}
		const description = describe(element);
		globalThis.piBrowserPoint = { element, fields: controlState(element), description: JSON.stringify(description) };
		return description;
	}
	if (args.snapshot !== globalThis.piBrowserSnapshot) throw Error("Page changed. Read again.");
	if (action === "inspect") {
		const el = globalThis.piBrowserElements?.[args.element - 1];
		globalThis.piBrowserFields = controlState(el);
		return describe(el);
	}
	globalThis.piBrowserSnapshot = undefined;
	if (action === "scroll") {
		window.scrollBy(0, args.direction === "up" ? -innerHeight : innerHeight);
		return true;
	}
	const el = globalThis.piBrowserElements?.[args.element - 1];
	if (!el?.isConnected || !visible(el) || el.matches(":disabled")) throw Error("Element changed. Read the page again.");
	if (action === "click") {
		if (globalThis.piBrowserFields !== controlState(el) || JSON.stringify(describe(el)) !== JSON.stringify(args.expected)) throw Error("Element changed. Read again.");
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
	let active, shown, bounds, owner, snapshot, attached, visual, confirmation;
	const requests = new Map();
	const current = () => tabs.get(active)?.webContents;
	const invalidate = () => {
		snapshot = undefined;
		visual = undefined;
		confirmation?.finish(false);
	};
	const state = () => ({
		active,
		owner,
		confirmation: confirmation?.display,
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
		const manualInput = () => { if (active === wc.id) invalidate(); };
		wc.on("before-input-event", manualInput);
		wc.on("before-mouse-event", (_event, input) => {
			if (["mouseDown", "mouseWheel", "touchStart"].includes(input.type)) manualInput();
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
				case "answer": {
					if (value?.id === confirmation?.display.id && confirmation) confirmation.finish(value.accept === true);
					break;
				}
				case "bounds": {
					if (value) {
						const scale = win.webContents.getZoomFactor();
						const next = {
							x: Math.round(value.x * scale),
							y: Math.round(value.y * scale),
							width: Math.round(value.width * scale),
							height: Math.round(value.height * scale),
						};
						if ((visual || confirmation) && JSON.stringify(next) !== JSON.stringify(bounds)) invalidate();
						bounds = next;
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
		if (["fill", "type"].includes(a.action) && typeof a.text !== "string") throw Error("Missing input text.");
		if (a.action === "key" && !["Enter", "Tab", "Escape", "ArrowDown", "ArrowUp"].includes(a.key)) throw Error("Unsupported key.");
		if (wc.isLoadingMainFrame()) throw Error("Page is loading. Read again.");
		const blank = !wc.getURL() || wc.getURL() === "about:blank";
		if (!blank) url(wc.getURL());
		const signal = requests.get(msg.id).signal;
		const observe = ["read", "view", "find", "tabs"].includes(a.action);
		if (!observe && (!snapshot || a.snapshot !== snapshot)) throw Error("Page changed. Read the active tab again.");
		const token = observe ? randomUUID() : snapshot;
		if (observe) {
			invalidate();
			snapshot = token;
		}
		const check = () => {
			if (signal.aborted || snapshot !== token || current() !== wc || owner !== msg.owner || !shown || !bounds || !getWindow()?.isVisible())
				throw Error("Page changed or request cancelled. Read again.");
		};
		const run = (action, data = a) => wc.executeJavaScriptInIsolatedWorld(1001, [{
			code: "(" + pageAction.toString() + ")(" + JSON.stringify(action) + "," + JSON.stringify(data) + "," + JSON.stringify(token) + ")",
		}]);
		async function approve(target) {
			check();
			const accepted = await new Promise(resolve => {
				const cancel = () => confirmation?.finish(false);
				confirmation = {
					display: { id: randomUUID(), site: blank ? "about:blank" : new URL(wc.getURL()).host, target, purpose: a.purpose },
					finish(answer) {
						confirmation = undefined;
						signal.removeEventListener("abort", cancel);
						publish();
						resolve(answer);
					},
				};
				signal.addEventListener("abort", cancel, { once: true });
				publish();
			});
			if (!accepted) {
				if (snapshot === token) invalidate();
				throw Error("Action cancelled. Do not retry.");
			}
			check();
		}
		async function capture() {
			const native = await wc.capturePage();
			check();
			const png = native.toPNG({ scaleFactor: 1 });
			const img = nativeImage.createFromBuffer(png);
			if (img.isEmpty()) throw Error("Empty browser screenshot.");
			const small = img.getSize().width > 1440 ? img.resize({ width: 1440 }) : img;
			return small;
		}
		if (a.action === "tabs") return { snapshot: token, active, tabs: state().tabs.map(({ id, title }) => ({ id, title })) };
		if (a.action === "selectTab") {
			select(a.tab);
			return "Tab selected";
		}
		if (a.purpose && ["fill", "navigate", "openTab"].includes(a.action)) await approve(a.url || a.action);
		if (a.action === "openTab") {
			const destination = a.url && url(a.url);
			const tab = add();
			if (destination) await tab.loadURL(destination);
			return "Tab opened";
		}
		if (a.action === "navigate") {
			await wc.loadURL(url(a.url));
			return "Navigated";
		}
		if (blank && a.action === "read") return { snapshot: token, text: "New tab", elements: [] };
		if (blank) throw Error("Navigate to a web page first.");
		if (a.action === "view") {
			const viewport = { ...bounds };
			const zoom = wc.getZoomFactor();
			const focus = await run("rememberFocus");
			const frame = await capture();
			check();
			if (bounds.width !== viewport.width || bounds.height !== viewport.height || wc.getZoomFactor() !== zoom) throw Error("Viewport changed. View again.");
			visual = { ...frame.getSize(), frame, focus, zoom };
			return { snapshot: token, ...frame.getSize(), image: frame.toJPEG(80).toString("base64") };
		}
		if (["clickAt", "scrollAt", "type", "key"].includes(a.action)) {
			const shot = visual;
			if (!shot || shot.zoom !== wc.getZoomFactor()) throw Error("View the current page first.");
			const pointer = a.action === "clickAt" || a.action === "scrollAt";
			if (pointer && !(Number.isInteger(a.x) && a.x >= 0 && a.x < shot.width && Number.isInteger(a.y) && a.y >= 0 && a.y < shot.height))
				throw Error("Coordinates outside screenshot.");
			const location = { fractionX: a.x / shot.width, fractionY: a.y / shot.height };
			const target = a.action === "clickAt" ? await run("inspectPoint", location) : undefined;
			check();
			if (target?.confirm || a.key === "Enter" || a.purpose)
				await approve(target ? `${target.label} (${a.x}, ${a.y})` : [a.key || a.action, shot.focus].filter(Boolean).join(" · "));
			getWindow().focus();
			if (pointer) {
				const frame = await capture();
				const x = Math.max(0, a.x - 24), y = Math.max(0, a.y - 24);
				const region = { x, y, width: Math.min(49, shot.width - x), height: Math.min(49, shot.height - y) };
				if (!frame.crop(region).toBitmap().equals(shot.frame.crop(region).toBitmap()) ||
					(target && !await run("checkPoint", location))) throw Error("Screenshot target changed. View again.");
			} else if (!await run("checkFocus")) throw Error("Focused field changed. View again.");
			check();
			if (shot.zoom !== wc.getZoomFactor()) throw Error("Page zoom changed. View again.");
			const point = pointer ? { x: Math.floor(a.x * bounds.width / shot.width), y: Math.floor(a.y * bounds.height / shot.height) } : undefined;
			invalidate();
			wc.focus();
			if (a.action === "clickAt") {
				for (const type of ["mouseDown", "mouseUp"]) wc.sendInputEvent({ type, ...point, button: "left", clickCount: 1 });
			} else if (a.action === "scrollAt") wc.sendInputEvent({ type: "mouseWheel", ...point, deltaX: 0, deltaY: (a.direction === "up" ? 1 : -1) * Math.round(bounds.height * .8) });
			else if (a.action === "type") await wc.insertText(a.text);
			else {
				wc.sendInputEvent({ type: "keyDown", keyCode: a.key });
				if (a.key === "Enter") wc.sendInputEvent({ type: "char", keyCode: "\r" });
				wc.sendInputEvent({ type: "keyUp", keyCode: a.key });
			}
			return "Done";
		}
		let data = a;
		if (a.action === "click") {
			const target = await run("inspect");
			check();
			if (target.confirm || a.purpose) await approve(target.label);
			data = { ...a, expected: target };
		}
		const result = await run(a.action, data);
		if (observe) {
			check();
			return { snapshot: token, ...result };
		}
		invalidate();
		return "Done";
	}
	return {
		hide,
		reset() {
			hide();
			publish();
		},
		attach(child) {
			child.once("disconnect", () => { for (const request of requests.values()) request.abort(); });
			child.on("message", msg => {
				if (msg?.type === "embedded-browser-cancel") { requests.get(msg.id)?.abort(); return; }
				if (msg?.type !== "embedded-browser") return;
				const reply = body => {
					if (child.connected) child.send({ type: msg.type, id: msg.id, ...body }, () => {});
				};
				if (requests.size) {
					reply({ error: "Browser is busy. Wait for the current action." });
					return;
				}
				requests.set(msg.id, new AbortController());
				execute(msg).then(
					result => reply({ result }),
					err => reply({ error: err.message }),
				).finally(() => requests.delete(msg.id));
			});
		},
	};
}
