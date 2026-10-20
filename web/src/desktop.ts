export interface AppUpdateState {
	phase: "idle" | "unsupported" | "checking" | "available" | "current" | "downloading" | "downloaded" | "error";
	current: string;
	latest?: string;
	percent?: number;
	error?: string;
}
export interface DesktopWindowState {
	maximized: boolean;
	fullscreen: boolean;
	/** Page fullscreen requested while macOS still animates the window into fullscreen. */
	fullscreenSettling?: boolean;
}

export interface DesktopAPI {
	platform: string;
	assistantVisibility?: (visible: boolean) => Promise<void>;
	onAssistantHidden?: (callback: () => void) => () => void;
	onBeforeClose?: (callback: () => Promise<boolean>) => () => void;
	clientId?: string;
	appUpdate?: (action: "read" | "check" | "update" | "install") => Promise<AppUpdateState>;
	onAppUpdate?: (callback: (state: AppUpdateState) => void) => () => void;
	openExtensionPath?: (request: { clientId: string; cwd: string; id: string }) => Promise<void>;
	openWikiFile?: (request: { clientId: string; cwd: string; path: string }) => Promise<void>;
	windowAction: (action: "minimize" | "toggle-maximize" | "close") => void;
	onWindowState: (callback: (state: DesktopWindowState) => void) => () => void;
}

declare global {
	interface Window {
		electronAPI?: DesktopAPI;
	}
}

export const desktopAPI = window.electronAPI;

const windowSaves = new Set<() => Promise<boolean>>();
export function registerWindowSave(save: () => Promise<boolean>) {
	windowSaves.add(save);
	return () => { windowSaves.delete(save); };
}
export async function flushWindowSaves() {
	const results = await Promise.allSettled([...windowSaves].map(save => save()));
	return results.every(result => result.status === "fulfilled" && result.value);
}

/** Resolves once the desktop window has finished entering fullscreen; leaving mid-animation never settles on macOS. */
export function fullscreenSettled(timeout = 3000): Promise<void> {
	if (!desktopAPI) return Promise.resolve();
	return new Promise(resolve => {
		let stop = () => {};
		const done = () => { clearTimeout(timer); stop(); resolve(); };
		const timer = setTimeout(done, timeout);
		stop = desktopAPI!.onWindowState(state => { if (!state.fullscreenSettling) done(); });
	});
}
