(async () => {
	const button = document.querySelector("#toggle");
	const status = document.querySelector("#status");
	const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
	if (!/^https?:\/\//.test(tab?.url ?? "")) {
		status.textContent = "请在需要读取的网页上打开扩展。";
		return;
	}
	const url = new URL(tab.url);
	const grant = {origins: [url.protocol + "//" + url.hostname + "/*"]};
	document.querySelector("#site").textContent = grant.origins[0];
	let allowed;
	async function refresh() {
		allowed = await chrome.permissions.contains(grant);
		button.textContent = allowed ? "撤销此网站授权" : "允许读取此网站";
		button.disabled = false;
	}
	button.onclick = async () => {
		try {
			if (allowed) await chrome.permissions.remove(grant);
			else await chrome.permissions.request(grant);
			await refresh();
			status.textContent = allowed ? "已授权，可回到 pi 读取。" : "此网站尚未授权。";
		} catch (err) { status.textContent = err.message; }
	};
	await refresh();
	await chrome.runtime.sendMessage("connect");
})();
