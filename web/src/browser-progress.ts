import type { useT } from "./i18n";

const actions = {
	find: "browserFind",
	tabs: "browserTabs",
	openTab: "browserOpenTab",
	selectTab: "browserSelectTab",
	view: "browserView",
	clickAt: "browserActionClick",
	scrollAt: "browserActionScroll",
	type: "browserActionFillForm",
	key: "browserKey",
	read: "browserActionSnapshot",
	navigate: "browserActionNavigate",
	click: "browserActionClick",
	fill: "browserActionFillForm",
	scroll: "browserActionScroll",
} as const;

export function browserAction(name: string, t: ReturnType<typeof useT>, argsText?: string) {
	if (name !== "embedded_browser") return undefined;
	try {
		const action = JSON.parse(argsText || "{}").action;
		if (Object.hasOwn(actions, action)) return t(actions[action as keyof typeof actions]);
	} catch { /* Streaming tool arguments may still be incomplete. */ }
	return t("embeddedBrowser");
}

export function browserTarget(argsText: string | undefined): string {
	try {
		const url = new URL(JSON.parse(argsText || "{}").url);
		if (url.protocol === "https:" || url.protocol === "http:") return url.hostname + url.pathname;
	} catch { /* Most actions operate on the current page. */ }
	return "";
}
