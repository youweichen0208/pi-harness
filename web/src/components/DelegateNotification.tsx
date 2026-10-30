import type { UiMessage } from "../types";
import { useT } from "../i18n";
import { parseDelegateNotification } from "../../../server/delegate-notification";

export function DelegateNotification({ message }: { message: UiMessage }) {
	const t = useT();
	const text = message.content.map(block => block.type === "text" ? block.text : "").join("\n");
	const notification = parseDelegateNotification(text);
	if (!notification) return <pre>{text}</pre>;
	return <details className="delegate-notification" data-msg-id={message.id}>
		<summary>
			<span className={notification.status === "failed" ? "delegate-notification-failed" : "delegate-notification-completed"}>
				{t(notification.status === "failed" ? "delegateNotificationFailed" : "delegateNotificationCompleted")}
			</span>
			<span>{notification.agent}</span>
			<code>{notification.runId}</code>
		</summary>
		<pre>{text}</pre>
	</details>;
}
