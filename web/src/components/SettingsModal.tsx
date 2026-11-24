import { isTopDialog, useDialogFocus } from "../use-dialog-focus";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { BuiltinExtensionsPanel } from "./BuiltinExtensionsPanel";
import { ExtensionsPanel } from "./ExtensionsPanel";
import { useState, useEffect } from "react";
import { FiX, FiDroplet, FiSettings, FiCpu, FiPackage, FiBox } from "react-icons/fi";
import { useT } from "../i18n";
import type { ClientMessage, UiSettingsState } from "../types";
import { AppearancePanel } from "./AppearancePanel";
import { NativeMcpPanel } from "./NativeMcpPanel";
import { SkillsPanel } from "./SkillsPanel";

type Tab = "prompt" | "appearance" | "skills" | "extensions" | "native-mcp";
interface SettingsModalProps {
	initialTab?: Tab;
	onInstallPiCli: () => void;
	chat: {
		ready: boolean;
		settings: UiSettingsState | null;
		state?: { isStreaming?: boolean; cwd: string; conversationId: string; tree?: import("../types").UiTreeState } | null;
		dialog: { id: string; conversationId: string; kind: "select" | "confirm" | "input" | "editor"; title: string; args: unknown[] } | null;
	};
	send: (message: ClientMessage) => boolean;
	onClose: () => void;
}

export function SettingsModal({ chat, send, onClose, onInstallPiCli, initialTab = "prompt" }: SettingsModalProps) {
	const t = useT();
	const dialogRef = useDialogFocus();
	const canLeave=()=>!document.querySelector('.ext-editor[data-dirty="true"], .prompt-editor[data-dirty="true"], .mcp-workbench[data-dirty="true"]')||window.confirm(t("extDiscard"));
	const close=()=>{if(canLeave())onClose();};
	useEffect(() => { const handle = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented && isTopDialog(dialogRef.current)) close(); }; window.addEventListener("keydown", handle); return () => window.removeEventListener("keydown", handle); }, [onClose]);
	const [tab, setTab] = useState<Tab>(initialTab);
	const settings = chat.settings;
	const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
		{ id: "prompt", label: t("settingsSystemPrompt"), icon: <FiSettings /> },
		{ id: "appearance", label: t("settingsAppearance"), icon: <FiDroplet /> },
		{ id: "skills", label: t("settingsSkills"), icon: <FiCpu /> },
		{ id: "extensions", label: t("settingsExtensions"), icon: <FiPackage /> },
		{ id: "native-mcp", label: t("nativeMcp"), icon: <FiBox /> },
	];
	return <div className="modal-backdrop" onClick={close}>
		<div className="modal settings-modal" ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("settingsTitle")} onClick={event => event.stopPropagation()}>
			<div className="modal-head"><button className="icon-btn" aria-label={t("close")} onClick={close}><FiX /></button></div>
			<div className="settings-layout">
				<nav className="settings-rail" aria-label={t("settingsTitle")}><h2>{t("settingsTitle")}</h2>{tabs.map(item => <button key={item.id} title={item.label} aria-current={tab === item.id ? "page" : undefined} className={`settings-tab${tab === item.id ? " active" : ""}`} onClick={() => { if(canLeave())setTab(item.id); }}><span className="settings-tab-icon">{item.icon}</span><span className="settings-tab-label">{item.label}</span></button>)}</nav>
				<div className="modal-body"><div className="set-section">
					{!settings ? <p>{t("loading")}</p> : <>
						{tab !== "appearance" && <label className="tree-edit-preference"><input type="checkbox" checked={settings.editResendNewSession ?? false} onChange={event => send({ type: "set_settings", editResendNewSession: event.target.checked })} />{t("treeEditNewSession")}</label>}
						{tab === "prompt" && chat.state && <SystemPromptPanel key={`${chat.state.cwd}:${chat.state.conversationId}`} cwd={chat.state.cwd} conversationId={chat.state.conversationId} />}
						{tab === "appearance" && <AppearancePanel />}
						{tab === "skills" && chat.state && <SkillsPanel key={chat.state.cwd} cwd={chat.state.cwd} reload={() => send({ type: "extensions_reload" })} />}
						{tab === "extensions" && chat.state?.cwd && <ExtensionsPanel
							cliInstall={{ ready: chat.ready, run: () => { if (canLeave()) onInstallPiCli(); } }}
							key={chat.state.cwd} cwd={chat.state.cwd}
							reload={() => send({ type: "extensions_reload" })}
							builtins={<BuiltinExtensionsPanel
								key={chat.state.conversationId} cwd={chat.state.cwd} conversationId={chat.state.conversationId}
								ready={chat.ready} canReload={!chat.state.isStreaming && !chat.state.tree?.verifying && !chat.state.tree?.externallyModified && !chat.state.tree?.busy}
								reload={() => send({ type: "extensions_reload" })} openNative={() => setTab("native-mcp")}
							/>}
						/>}
						{tab === "native-mcp" && chat.state?.cwd && <NativeMcpPanel key={`${chat.state.cwd}:${chat.state.conversationId}`} cwd={chat.state.cwd} send={send} dialog={chat.dialog} />}
					</>}
				</div></div>
			</div>
		</div>
	</div>;
}
