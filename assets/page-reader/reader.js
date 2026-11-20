// References belong to this worker and expire when the listed URL changes.
const pages = new Map();
async function allowed(url) {
	if (!url || !/^https?:\/\//.test(url)) return false;
	const {protocol, hostname} = new URL(url);
	return chrome.permissions.contains({origins: [protocol + "//" + hostname + "/*"]});
}
async function handle(request) {
	if (request.action === "list") {
		const matches = [];
		const query = request.query.toLowerCase();
		for (const tab of await chrome.tabs.query({})) {
			if (!await allowed(tab.url) || !(tab.title + " " + tab.url).toLowerCase().includes(query)) continue;
			if (pages.get(tab.id)?.url !== tab.url) pages.set(tab.id, {key: crypto.randomUUID(), url: tab.url});
			matches.push({key: pages.get(tab.id).key, title: tab.title.slice(0, 300), url: tab.url.slice(0, 2048)});
			if (matches.length === 64) break;
		}
		return matches;
	}
	if (request.action !== "read") throw Error("Unknown reader action");
	const entry = [...pages].find(([, page]) => page.key === request.key);
	if (!entry) throw Error("标签页已关闭或已更换，请重新查找。");
	const [tabId, page] = entry;
	if (!await allowed(page.url)) throw Error("该网站的读取授权已撤销。");
	const [{result}] = await chrome.scripting.executeScript({target: {tabId}, args: [page.url], func: expected => {
		if (location.href !== expected) return {error: "标签页地址已改变，请重新查找。"};
		const articles = document.querySelectorAll("article");
		const main = document.querySelector('main, [role="main"]') ?? (articles.length === 1 ? articles[0] : null);
		const text = main?.innerText?.trim() || document.body?.innerText.trim() || "";
		if (!text) return {error: "页面没有可读取的已加载正文。"};
		return {title: document.title.slice(0, 300), url: location.href.slice(0, 2048), text: text.slice(0, 60000), truncated: text.length > 60000};
	}});
	if (!result || result.error) throw Error(result?.error || "页面已关闭。");
	if (!await allowed(page.url)) throw Error("该网站的读取授权已撤销。");
	return result;
}
chrome.tabs.onRemoved.addListener(id => pages.delete(id));
chrome.tabs.onUpdated.addListener((id, changes) => { if (changes.url) pages.delete(id); });
let port;
function connect() {
	if (port) return;
	const connection = chrome.runtime.connectNative("com.pi_harness.page_reader");
	port = connection;
	connection.onDisconnect.addListener(() => { void chrome.runtime.lastError; port = undefined; });
	connection.onMessage.addListener(async request => {
		let reply;
		try { reply = {value: await handle(request)}; }
		catch (err) { reply = {error: err.message}; }
		if (port === connection) connection.postMessage({id: request.id, ...reply});
	});
}
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onMessage.addListener(connect);
