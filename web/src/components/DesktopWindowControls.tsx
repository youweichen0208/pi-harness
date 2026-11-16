import { useEffect, useState } from "react";
import { FiCopy, FiMinus, FiSquare, FiX } from "react-icons/fi";
import { desktopAPI, type DesktopWindowState } from "../desktop";
import { useT } from "../i18n";

/**
 * Window buttons for the frameless shell.
 *
 * macOS keeps its native traffic lights (`titleBarStyle: "hidden"`); Windows and
 * Linux draw the same three dots at the same place (`left: 18px; top: 17px`, 12px
 * circles with an 8px gap) so both platforms share one header layout instead of
 * one side reserving space for macOS lights and the other for Windows controls.
 * The hover glyphs and the button order follow macOS; the actions stay native.
 */
export function DesktopWindowControls() {
	const t = useT();
	const [windowState, setWindowState] = useState<DesktopWindowState>({ maximized: false, fullscreen: false });
	useEffect(() => desktopAPI?.onWindowState(setWindowState), []);
	const api = desktopAPI;
	if (!api || api.platform === "darwin") return null;
	const restore = windowState.maximized || windowState.fullscreen;
	return <div className="desktop-window-controls" aria-label={t("windowControls")}>
		<button type="button" className="desktop-window-close" title={t("closeWindow")} aria-label={t("closeWindow")} onClick={() => api.windowAction("close")}><FiX aria-hidden="true" /></button>
		<button type="button" className="desktop-window-minimize" title={t("minimizeWindow")} aria-label={t("minimizeWindow")} onClick={() => api.windowAction("minimize")}><FiMinus aria-hidden="true" /></button>
		<button type="button" className="desktop-window-maximize" title={t(restore ? "restoreWindow" : "maximizeWindow")} aria-label={t(restore ? "restoreWindow" : "maximizeWindow")} onClick={() => api.windowAction("toggle-maximize")}>{restore ? <FiCopy aria-hidden="true" /> : <FiSquare aria-hidden="true" />}</button>
	</div>;
}
