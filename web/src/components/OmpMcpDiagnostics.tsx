import type { UiOmpMcpFailure, UiOmpMcpRuntime } from "../types";
import { useT } from "../i18n";

const failureKeys = {
	connect: "ompMcpFailureConnect", timeout: "ompMcpFailureTimeout", eof: "ompMcpFailureClosed",
	reset: "ompMcpFailureClosed", closed: "ompMcpFailureClosed", malformed_response: "ompMcpFailureMalformed",
	json_rpc: "ompMcpFailureRpc", http_status: "ompMcpFailureHttp", unknown: "ompMcpFailureUnknown",
} as const;
const eventKeys = { connecting: "mcpConnecting", reconnecting: "ompMcpReconnecting", connected: "mcpConnected", failed: "ompMcpConnectionFailed" } as const;

export function OmpMcpFailure({ failure }: { failure: UiOmpMcpFailure }) {
	const t = useT();
	return <span className="omp-mcp-failure">{t(failureKeys[failure.failure] ?? "ompMcpFailureUnknown")}{failure.httpStatus !== undefined && ` (HTTP ${failure.httpStatus})`}</span>;
}

export function OmpMcpDiagnostics({ diagnostics }: { diagnostics: NonNullable<UiOmpMcpRuntime["diagnostics"]> }) {
	const t = useT();
	return <details className="omp-mcp-diagnostics">
		<summary>{t("ompMcpDiagnostics")}</summary>
		<p className="settings-intro">{t("ompMcpDiagnosticsHelp")}</p>
		{diagnostics.dropped > 0 && <p>{t("ompMcpDiagnosticsDropped", { n: diagnostics.dropped })}</p>}
		{!diagnostics.events.length && <p className="settings-empty">{t("ompMcpDiagnosticsEmpty")}</p>}
		<ol>{[...diagnostics.events].reverse().map(event => <li key={event.sequence}>
			<time dateTime={new Date(event.observedAt).toISOString()}>{new Date(event.observedAt).toLocaleString()}</time>{" "}
			<strong>{event.name}</strong>{" · "}{t(eventKeys[event.type])}{event.transport !== "unknown" && ` · ${event.transport.toUpperCase()}`}
			{event.origin === "snapshot" && <> · {t("ompMcpDiagnosticsSnapshot")}</>}
			{event.failure && <><br /><OmpMcpFailure failure={{ transport: event.transport, failure: event.failure, httpStatus: event.httpStatus }} /></>}
		</li>)}</ol>
	</details>;
}
