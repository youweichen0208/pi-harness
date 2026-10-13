/** Background tints. `graphite` is the dark appearance; the rest are light. */
export const THEMES = ["warm", "mist", "sage", "oat", "graphite"] as const;
export type Theme = (typeof THEMES)[number];
export interface AppearanceState { theme: Theme; follow: boolean }

export const THEME_KEY = "pi-harness:theme";
export const FOLLOW_KEY = "pi-harness:theme-follow";
/** Pre-theme setting: "light" | "dark" | "system". Read once as a fallback. */
export const LEGACY_KEY = "pi-harness:appearance";

const isTheme = (value: unknown): value is Theme => THEMES.includes(value as Theme);
/** The light theme used when following a light system, or when graphite is left. */
export const lightThemeOf = (theme: Theme): Theme => (theme === "graphite" ? "warm" : theme);

export function resolveAppearance(state: AppearanceState, systemDark: boolean): Theme {
	if (!state.follow) return state.theme;
	return systemDark ? "graphite" : lightThemeOf(state.theme);
}

export function readAppearanceState(storage: { getItem(key: string): string | null }): AppearanceState {
	try {
		const stored = storage.getItem(THEME_KEY);
		if (isTheme(stored)) return { theme: stored, follow: storage.getItem(FOLLOW_KEY) === "1" };
		const legacy = storage.getItem(LEGACY_KEY);
		if (legacy === "dark") return { theme: "graphite", follow: false };
		if (legacy === "system") return { theme: "warm", follow: true };
	} catch { /* private browsing */ }
	return { theme: "warm", follow: false };
}
