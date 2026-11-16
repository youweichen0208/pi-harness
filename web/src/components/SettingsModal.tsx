import { isTopDialog, useDialogFocus } from "../use-dialog-focus";
import { OmpPromptPanel } from "./OmpPromptPanel";
import { OmpResourcesPanel } from "./OmpResourcesPanel";
import { useState, useEffect } from "react";
import { FiX, FiDroplet, FiSettings, FiCpu, FiPackage, FiBox } from "react-icons/fi";
import { useT } from "../i18n";
import type { ClientMessage, ServerMessage, UiSettingsState } from "../types";
import { AppearancePanel } from "./AppearancePanel";


type Tab = "prompt" | "appearance" | "skills" | "extensions" | "native-mcp";
interface SettingsModalProps {
	initialTab?: Tab;
	chat: {
		ready: boolean;
		settings: UiSettingsState | null;
		state?: { isStreaming?: boolean; cwd: string; conversationId: string; tree?: import("../types").UiTreeState } | null;
		dialog: Extract<ServerMessage, { type: "dialog" }> | null;
	};
	send: (message: ClientMessage) => boolean;
	onClose: () => void;
}

export function SettingsModal({ chat, send, onClose, initialTab = "prompt" }: SettingsModalProps) {
	const t = useT();
	const dialogRef = useDialogFocus();
	const canLeave=()=>!document.querySelector('.ext-editor[data-dirty="true"], .prompt-editor[data-dirty="true"], .mcp-workbench[data-dirty="true"], .omp-skill-settings[data-dirty="true"], .omp-mcp-panel[data-dirty="true"], .omp-extension-panel[data-dirty="true"], .omp-package-features[data-dirty="true"], .omp-package-settings[data-dirty="true"]')||window.confirm(t("extDiscard"));
	const close=()=>{if(canLeave())onClose();};
	useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && isTopDialog(dialogRef.current)) close(); }; window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle); }, [onClose]);
	const [tab, setTab] = useState<Tab>(initialTab);
	const settings = chat.settings;
	const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
		{ id: "prompt", label: t("settingsSystemPrompt"), icon: <FiSettings /> },
		{ id: "appearance", label: t("settingsAppearance"), icon: <FiDroplet /> },
		{ id: "skills", label: t("settingsSkills"), icon: <FiCpu /> },
		{ id: "extensions", label: t("settingsExtensions"), icon: <FiPackage /> },
		{ id: "native-mcp", label: t("ompTools"), icon: <FiBox /> },
	];
	return <div className="modal-backdrop" onClick={close}>
		<div className="modal settings-modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("settingsTitle")} onClick={event => event.stopPropagation()}>
			<div className="modal-head"><button className="icon-btn" aria-label={t("close")} onClick={close}><FiX /></button></div>
			<div className="settings-layout">
				<nav className="settings-rail" aria-label={t("settingsTitle")}><h2>{t("settingsTitle")}</h2>{tabs.map(item => <button key={item.id} title={item.label} aria-current={tab === item.id ? "page" : undefined} className={`settings-tab${tab === item.id ? " active" : ""}`} onClick={() => { if(canLeave())setTab(item.id); }}><span className="settings-tab-icon">{item.icon}</span><span className="settings-tab-label">{item.label}</span></button>)}</nav>
				<div className="modal-body"><div className="set-section">
					{!settings ? <p>{t("loading")}</p> : <>
						{tab !== "appearance" && <label className="tree-edit-preference"><input type="checkbox" checked={settings.editResendNewSession ?? false} onChange={event => send({ type: "set_settings", editResendNewSession: event.target.checked })} />{t("treeEditNewSession")}</label>}
						{tab === "prompt" && chat.state && <OmpPromptPanel key={`${chat.state.cwd}:${chat.state.conversationId}`} cwd={chat.state.cwd} conversationId={chat.state.conversationId} running={!!chat.state.isStreaming} />}
						{tab === "appearance" && <AppearancePanel />}
						{(tab === "skills" || tab === "extensions" || tab === "native-mcp") && chat.state && <OmpResourcesPanel key={`${chat.state.cwd}:${chat.state.conversationId}:${tab}`} cwd={chat.state.cwd} conversationId={chat.state.conversationId} section={tab} busy={!!chat.state.isStreaming} />}
					</>}
				</div></div>
			</div>
		</div>
	</div>;
}
