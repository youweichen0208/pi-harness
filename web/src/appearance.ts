import { THEME_CHANGE_EVENT } from "./theme";
import { FOLLOW_KEY, LEGACY_KEY, THEME_KEY, readAppearanceState, resolveAppearance, type AppearanceState } from "./appearance-model";

export { THEMES, lightThemeOf, type AppearanceState, type Theme } from "./appearance-model";
const EXPRESSIONS_KEY = "pi-web:agent-expressions";
export function getAgentExpressions(): boolean {
	try { return localStorage.getItem(EXPRESSIONS_KEY) !== "0"; } catch { return true; }
}
export function setAgentExpressions(enabled: boolean) {
	try { localStorage.setItem(EXPRESSIONS_KEY, enabled ? "1" : "0"); } catch { /* private browsing */ }
	document.documentElement.dataset.agentExpressions = String(enabled);
	window.dispatchEvent(new Event(APPEARANCE_EVENT));
}

export const APPEARANCE_EVENT = "pi-harness:appearance";

export function getAppearanceState(): AppearanceState {
	try { return readAppearanceState(localStorage); } catch { return { theme: "warm", follow: false }; }
}

function systemDark(): boolean {
	return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

function apply(state: AppearanceState = getAppearanceState()) {
	const theme = resolveAppearance(state, systemDark());
	const root = document.documentElement;
	root.dataset.agentExpressions = String(getAgentExpressions());
	root.dataset.theme = theme;
	root.dataset.appearance = theme === "graphite" ? "dark" : "light";
	window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
	window.dispatchEvent(new Event(APPEARANCE_EVENT));
}

export function setAppearanceState(state: AppearanceState) {
	try {
		localStorage.setItem(THEME_KEY, state.theme);
		localStorage.setItem(FOLLOW_KEY, state.follow ? "1" : "0");
	} catch { /* private browsing */ }
	apply(state);
}

export function initAppearance() {
	apply();
	const visibility = () => { document.documentElement.dataset.pageHidden = String(document.hidden); };
	visibility();
	document.addEventListener("visibilitychange", visibility);
	if (typeof matchMedia === "function") {
		matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
			if (getAppearanceState().follow) apply();
		});
	}
	window.addEventListener("storage", event => {
		if (event.key === THEME_KEY || event.key === FOLLOW_KEY || event.key === LEGACY_KEY || event.key === EXPRESSIONS_KEY || event.key === null) apply();
	});
}
