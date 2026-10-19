import { useEffect, useState } from "react";
import { FiCopy, FiMinus, FiSquare, FiX } from "react-icons/fi";
import { desktopAPI, type DesktopWindowState } from "../desktop";
import { useT } from "../i18n";

export function DesktopWindowControls() {
	const t = useT();
	const [windowState, setWindowState] = useState<DesktopWindowState>({ maximized: false, fullscreen: false });
	useEffect(() => desktopAPI?.onWindowState(setWindowState), []);
	const api = desktopAPI;
	if (!api || api.platform === "darwin") return null;
	const restore = windowState.maximized || windowState.fullscreen;
	return <div className="desktop-window-controls" aria-label={t("windowControls")}>
		<button type="button" title={t("minimizeWindow")} aria-label={t("minimizeWindow")} onClick={() => api.windowAction("minimize")}><FiMinus /></button>
		<button type="button" title={t(restore ? "restoreWindow" : "maximizeWindow")} aria-label={t(restore ? "restoreWindow" : "maximizeWindow")} onClick={() => api.windowAction("toggle-maximize")}>{restore ? <FiCopy /> : <FiSquare />}</button>
		<button type="button" className="desktop-window-close" title={t("closeWindow")} aria-label={t("closeWindow")} onClick={() => api.windowAction("close")}><FiX /></button>
	</div>;
}
