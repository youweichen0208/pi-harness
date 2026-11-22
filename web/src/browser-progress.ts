import type { useT } from "./i18n";

const actions = {
	find: "browserActionFind",
	snapshot: "browserActionSnapshot",
	evaluate: "browserActionEvaluate",
	navigate: "browserActionNavigate",
	navigate_back: "browserActionNavigateBack",
	click: "browserActionClick",
	hover: "browserActionHover",
	type: "browserActionType",
	fill_form: "browserActionFillForm",
	tabs: "browserActionTabs",
	take_screenshot: "browserActionTakeScreenshot",
	wait_for: "browserActionWaitFor",
	press_key: "browserActionPressKey",
	select_option: "browserActionSelectOption",
	drag: "browserActionDrag",
	close: "browserActionClose",
	resize: "browserActionResize",
	handle_dialog: "browserActionHandleDialog",
	file_upload: "browserActionFileUpload",
	network_requests: "browserActionNetworkRequests",
	console_messages: "browserActionConsoleMessages",
	run_code: "browserActionRunCode",
} as const;

export function browserAction(name: string, t: ReturnType<typeof useT>) {
	if (name === "page_reader_read") return t("pageReaderRead");
	if (name === "page_reader_find") return t("pageReaderFind");
	const prefix = "mcp__playwright_extension__browser_";
	if (!name.startsWith(prefix)) return undefined;
	const action = name.slice(prefix.length);
	const key = actions[action as keyof typeof actions];
	return Object.hasOwn(actions, action) ? t(key) : action.replaceAll("_", " ");
}

export function browserTarget(argsText: string | undefined, output: string): string {
	const title = /^- Page Title: (.+)$/m.exec(output.slice(0, 4096))?.[1];
	if (title) return title.trim();
	try {
		const args = JSON.parse(argsText || "{}");
		if (typeof args.element === "string") return args.element;
		if (typeof args.url === "string") {
			const url = new URL(args.url);
			if (url.protocol === "https:" || url.protocol === "http:") return url.hostname + url.pathname;
		}
	} catch { /* Partial arguments have no target yet. */ }
	return "";
}
