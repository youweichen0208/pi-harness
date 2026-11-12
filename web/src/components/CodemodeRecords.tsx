import { RunningIndicator } from "./RunningIndicator";
import type { ClientMessage, UiMessage } from "../types";
import { CodemodeHistoryDialog } from "./CodemodeHistoryDialog";
import { useEffect, useState } from "react";
import { FiChevronRight } from "react-icons/fi";
import { useChatT } from "../i18n";
import type { CodemodeGroup } from "../codemode-records";
import { commandDuration } from "../bash-presentation";

function Group({ group, index, onJump }: { group: CodemodeGroup; index: number; onJump: (group: CodemodeGroup) => void }) {
	const t = useChatT();
	const [open, setOpen] = useState(group.status === "running" || group.status === "queued");
	const [all, setAll] = useState(false);
	const failures = group.calls.filter(call => call.status === "error").length;
	const status = group.status === "completed" ? failures ? "cmRecordsPartial" : "executionCompleted" : group.status === "failed" ? "error" : group.status === "cancelled" ? "cmCancelled" : group.status === "unfinished" ? "cmUnfinished" : group.status === "queued" ? "toolQueued" : "running";
	const jump = () => onJump(group);
	return <div className="cm-record-group" data-codemode-group={group.id}>
		<button type="button" className="cm-record-heading" aria-expanded={open} onClick={() => setOpen(value => !value)}>
			<FiChevronRight className={open ? "open" : ""}/><strong>Codemode {index + 1}</strong><span>{t(group.countKnown ? "cmRecordsCount" : "cmRecordsReceived", { n: group.totalCalls })}</span>
			<small className={`cm-record-status ${group.status}`}>{t(status)}{group.durationMs !== undefined && ` · ${commandDuration(group.durationMs)}`}</small>
		</button>
		{group.omitted > 0 && <p className="cm-record-limit">{t("cmRecordsLimited", { shown: group.calls.length, total: group.totalCalls })}</p>}
		{open && <div className="cm-record-content">
			{!group.calls.length && <p className="ext-muted">{t(group.status === "running" || group.status === "queued" ? "cmWaitingCalls" : "cmNoCalls")}</p>}
			<ul>{(all ? group.calls : group.calls.slice(-8)).map(call => <li key={call.key} data-codemode-record={call.key}>
				<button type="button" className="cm-record-row" onClick={jump} title={t("taskJumpToChat")}>
					<span className={`cm-record-mark ${call.status}`} aria-label={t(call.status === "ok" ? "done" : call.status === "error" ? "error" : call.status === "cancelled" ? "cmCancelled" : call.status === "unfinished" ? "cmUnfinished" : "running")}>{call.status === "ok" ? "✓" : call.status === "error" ? "×" : call.status === "running" ? <RunningIndicator /> : "−"}</span>
					<span className="cm-record-description"><code>{call.name}</code><small>{call.args.replace(/\s+/g, " ").slice(0, 160)}</small></span>
					{call.durationMs !== undefined && <small className="cm-record-duration">{commandDuration(call.durationMs)}</small>}
				</button>
			</li>)}</ul>
			{group.calls.length > 8 && <button type="button" className="task-step-jump" onClick={() => setAll(value => !value)}>{t(all ? "cmCollapseCalls" : "cmMoreCalls", { n: group.calls.length - 8 })}</button>}
			{group.incompleteHistory && <p className="cm-record-limit">{t("cmRecordsIncomplete")}</p>}
			<button type="button" className="task-step-jump" onClick={jump}>{t("taskJumpToChat")} →</button>
		</div>}
	</div>;
}

export function CodemodeRecords({ groups, messages, conversationId, send }: { groups: CodemodeGroup[]; messages: UiMessage[]; conversationId?: string; send?: (message: ClientMessage) => boolean }) {
	const t = useChatT();
	const [open, setOpen] = useState(true);
	const [selected, setSelected] = useState<string>();
	const identity = (group: CodemodeGroup) => `${conversationId}:${group.requestId}:${group.id}:${group.entryId}`;
	const selectedGroup = groups.find(group => identity(group) === selected);
	useEffect(() => { if (selected && !selectedGroup) setSelected(undefined); }, [selected, selectedGroup]);
	const jump = (group: CodemodeGroup) => {
		if (messages.some(message => message.id === group.messageId)) window.dispatchEvent(new CustomEvent("pi:jump-tool", { detail: { messageId: group.messageId, toolCallId: group.id } }));
		else if (group.entryId) setSelected(identity(group));
	};
	if (!groups.length) return null;
	return <section className="task-section cm-records">
		<button type="button" className="task-section-heading" aria-expanded={open} onClick={() => setOpen(value => !value)}><FiChevronRight className={open ? "open" : ""}/>{t("cmRecordsHeading")}</button>
		<div hidden={!open}>{groups.map((group, index) => <Group key={`${group.requestId}:${group.id}`} group={group} index={index} onJump={jump}/>)}</div>
		{selectedGroup && conversationId && send && <CodemodeHistoryDialog key={selected} group={selectedGroup} conversationId={conversationId} send={send} onClose={() => setSelected(undefined)}/>}
	</section>;
}
