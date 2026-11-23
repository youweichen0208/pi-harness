import { useMemo, useState } from "react";
import type { UiTraceRun } from "../types";
import { useT } from "../i18n";
import { formatTraceMs as ms, traceShare, mergeHostIntervals } from "../trace-presentation";
import { copyText } from "../clipboard";

type Entry = {
	id: string;
	kind: "model" | "tool" | "host" | "background";
	label: string;
	start?: number;
	end?: number;
	status: string;
};
const duration = (e: Entry) =>
	e.status !== "ambiguous" && e.start !== undefined && e.end !== undefined && e.end >= e.start
		? e.end - e.start
		: null;
const shortModel = (name: string) => name.replace(/^deepseek-v([\d.]+)-flash$/i, "DeepSeek V$1 Flash");

export function TraceWaterfall({ run }: { run: UiTraceRun }) {
	const t = useT();
	const entries = useMemo(
		() =>
			[
				...run.requests.map((r) => ({
					id: "m:" + r.requestId,
					kind: "model" as const,
					label: `Turn ${r.turnIndex ?? "—"} · ${shortModel(r.model ?? r.provider ?? "—")}`,
					start: r.hookStartMs,
					end: r.messageEndMs,
					status: r.status,
				})),
				...(run.backgroundSpans ?? []).map(span => ({
					id: "bg:" + span.id, kind: "background" as const, label: t("backgroundTitle") + " · " + span.id,
					start: span.startMs, end: span.endMs ?? span.observedMs, status: span.state === "background" ? t("backgroundRunning") : span.state,
				})),
				...run.tools.map((r) => ({
					id: "t:" + r.toolCallId,
					kind: "tool" as const,
					label: (r.parentToolCallId ? "↳ " : "") + r.toolName,
					start: r.startMs,
					end: r.endMs,
					status: r.status,
				})),
			].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity)),
		[run, t],
	);
	const hosts = useMemo(
		() =>
			run.hostSpans.map((r, i) => ({
				id: "h:" + i,
				kind: "host" as const,
				label: r.kind,
				start: r.startMs,
				end: r.endMs,
				status: "measured",
			})),
		[run],
	);
	const longest = entries
		.filter((e) => e.kind === "model" && e.status === "measured" && duration(e) !== null)
		.sort((a, b) => duration(b)! - duration(a)!)[0];
	const [id, select] = useState<string>();
	const [windowRange, setRange] = useState<[number, number]>();
	const [expandedHosts, setExpandedHosts] = useState<Record<string, boolean>>({});
	const [feedback, setFeedback] = useState("");
	const entry =
		[...entries, ...hosts].find((e) => e.id === id) ??
		longest ??
		entries.find((e) => e.kind === "tool") ??
		entries[0];
	const request = run.requests.find((r) => entry?.id === "m:" + r.requestId);
	const tool = run.tools.find((r) => entry?.id === "t:" + r.toolCallId);
	const origin = run.agentStartMs;
	const limit = Math.max(
		origin + 0.001,
		run.agentSettledMs ?? origin, ...entries.map(e => e.end ?? e.start ?? origin), ...hosts.map(e => e.end),
	);
	const [lo, hi] = windowRange ?? [origin, limit];
	const relative = (v?: number) => (v === undefined ? t("wfMissing") : ms(v - origin));
	function zoom(center: number, width: number) {
		const size = Math.min(limit - origin, Math.max(0.001, width));
		const start = Math.max(origin, Math.min(limit - size, center - size / 2));
		setRange([start, start + size]);
	}
	const focusTool = (e: Entry) => {
		if (e.start === undefined) return;
		select(e.id);
		zoom(e.start + (duration(e) ?? 0) / 2, Math.max(1, (duration(e) ?? 0) * 4));
	};
	const target = entry?.kind === "tool" ? entry : entries.find((e) => e.kind === "tool");
	const stages = request
		? ([
				[t("wfStart"), request.hookStartMs],
				[t("wfHeaders"), request.firstHeadersMs],
				[t("wfFirst"), request.firstProviderEventMs],
				[t("wfOutput"), request.firstVisibleDeltaMs],
				[t("wfEnd"), request.messageEndMs],
			] as const)
		: [];
	const keys = ["model_wall_union_ms", "tool_wall_union_ms", "host_wall_union_ms", "unclassified_wall_ms"];
	const labels = [t("traceModel"), t("traceTools"), t("traceHost"), t("traceUnclassified")];
	const matched = run.requests.filter(
		(r) => r.status === "measured" && r.hookStartMs !== undefined && r.messageEndMs !== undefined,
	).length;
	const missingStage = run.requests.some((r) =>
		[r.hookStartMs, r.firstHeadersMs, r.firstProviderEventMs, r.firstVisibleDeltaMs, r.messageEndMs].some(
			(v, i, a) => v === undefined || (i > 0 && v < a[i - 1]!),
		),
	);
	const incomplete =
		run.status !== "measured" ||
		!!run.interrupted ||
		!!run.hostSpanOverflow ||
		run.requestsTruncated ||
		run.toolsTruncated ||
		matched !== run.requests.length ||
		missingStage ||
		keys.some((k) => !traceShare(run, k)) ||
		run.tools.some((r) => r.endMs === undefined);
	const ranked = keys
		.map((k, i) => ({ key: k, label: labels[i], value: run.aggregates[k]?.value ?? 0 }))
		.sort((a, b) => b.value - a.value);
	const top = ranked[0];
	const slowest = [...entries, ...hosts]
		.filter((e) => e.kind === ["model", "tool", "host"][keys.indexOf(top.key)] && duration(e) !== null)
		.sort((a, b) => duration(b)! - duration(a)!)[0];
	const dominant =
		top.value > ranked[1].value && top.value > (run.aggregates.agent_active_wall_ms?.value ?? Infinity) / 2;
	function bar(e: Entry) {
		if (e.start === undefined || e.start > hi || (e.end ?? e.start) < lo || e.status === "ambiguous") return null;
		const start = Math.max(lo, e.start);
		return (
			<i
				className={`trace-span trace-span-${e.kind} status-${e.status}`}
				style={{
					left: Math.min(100, (100 * (start - lo)) / (hi - lo)) + "%",
					width: Math.max(0, (100 * (Math.min(hi, e.end ?? start) - start)) / (hi - lo)) + "%",
				}}
			/>
		);
	}
	const info = (e: Entry) =>
		`${e.label} · ${relative(e.start)} → ${relative(e.end)} · ${ms(duration(e))} · ${e.status}`;
	function row(e: Entry) {
		return (
			<button
				key={e.id}
				className="wf-row"
				aria-pressed={entry?.id === e.id}
				title={info(e)}
				aria-label={info(e)}
				onClick={() => select(e.id)}
			>
				<span>{e.label}</span>
				<span className="trace-lane-track">{bar(e)}</span>
				<small>{ms(duration(e))}</small>
				<span className="wf-tip">{info(e)}</span>
			</button>
		);
	}
	return (
		<section className="wf">
			<p>
				{run.requests.length ? t("wfCoverage", { matched, total: run.requests.length }) : t("wfNoRequests")}
				{run.requestsTruncated && " · " + t("wfTruncated")}
			</p>
			<p className="wf-note">
				{incomplete
					? [
							t("wfPartial"),
							missingStage && t("wfStageMissing"),
							run.hostSpanOverflow && "host_spans_truncated",
							run.toolsTruncated && "tools_truncated",
							run.status !== "measured" && run.status,
						]
							.filter(Boolean)
							.join(" · ")
					: dominant
						? t("wfDominant", { label: top.label, share: traceShare(run, top.key) })
						: t("wfMixed")}
				{!incomplete && dominant && slowest && (
					<button
						className="wf-jump"
						onClick={() => {
							select(slowest.id);
							setRange(undefined);
						}}
					>
						{t("wfLongest")} · {slowest.label} · {ms(duration(slowest))}
					</button>
				)}
				{!incomplete && dominant && top.key === keys[3] && " " + t("wfGapHint")}
			</p>
			<h3>{t("traceTimeline")}</h3>
			<div className="wf-controls">
				<button onClick={() => setRange(undefined)}>{t("wfFit")}</button>
				<button disabled={!target} onClick={() => target && focusTool(target)}>
					{t("wfZoomTool")}
				</button>
				{[2, 0.5].map((scale) => (
					<button
						key={scale}
						aria-label={t(scale === 2 ? "wfOut" : "wfIn")}
						onClick={() => zoom((hi + lo) / 2, (hi - lo) * scale)}
					>
						{scale === 2 ? "−" : "+"}
					</button>
				))}
				<small>
					{relative(lo)} — {relative(hi)}
				</small>
			</div>
			<div className="wf-axis">
				<span>
					<small>{relative(lo)}</small>
					<small>{relative((lo + hi) / 2)}</small>
					<small>{relative(hi)}</small>
				</span>
			</div>
			{entries.map(row)}
			{Array.from(new Set(hosts.map((e) => e.label))).map((kind) => {
				const group = hosts
					.filter((e) => e.label === kind && e.end >= lo && e.start <= hi)
					.sort((a, b) => a.start - b.start);
				const merged = mergeHostIntervals(group, lo, hi);
				const total = merged.reduce((sum, e) => sum + e.end - e.start, 0);
				return (
					<details
						key={kind}
						onToggle={(event) => {
							const open = event.currentTarget.open;
							setExpandedHosts((prev) => (prev[kind] === open ? prev : { ...prev, [kind]: open }));
						}}
					>
						<summary>
							<span>{kind} · {group.length}</span>
							<span className="trace-lane-track">
								{merged.map((e) => (
									<span key={e.start}>
										{bar({ ...e, id: kind, label: kind, kind: "host", status: "measured" })}
									</span>
								))}
							</span>
							<small>{ms(total)}</small>
						</summary>
						{expandedHosts[kind] && group.map(row)}
					</details>
				);
			})}
			{entry && (
				<section className="wf-detail">
					<h3>{entry.label}</h3>
					<select aria-label={t("wfSelect")} value={entry.id} onChange={(e) => select(e.target.value)}>
						{entries.map((e) => (
							<option key={e.id} value={e.id}>
								{e.label} · {ms(duration(e))}
							</option>
						))}
						{entry.kind === "host" && <option value={entry.id}>{entry.label}</option>}
					</select>
					<p>{info(entry)}</p>
					{request && (
						<>
							<button
								onClick={async (e) => {
									try {
										await copyText(
											[request.provider, request.model].filter(Boolean).join("/"),
											e.currentTarget.ownerDocument,
										);
										setFeedback(t("copied"));
									} catch {
										setFeedback(t("wfCopyFail"));
									}
								}}
							>
								{[request.provider, request.model].filter(Boolean).join("/")} · {t("copy")}
							</button>
							<span role="status">{feedback}</span>
							<ol>
								{stages.map(([label, at], i) => {
									const previous = stages[i - 1]?.[1];
									return (
										<li key={label}>
											{label} · {relative(at)}{" "}
											{previous !== undefined && at !== undefined && at >= previous && (
												<small>(+{ms(at - previous)})</small>
											)}
										</li>
									);
								})}
							</ol>
							<p>
								{t("wfOutputHint")} · {request.firstOutputKind ?? t("wfUnknownKind")}
							</p>
							<p>
								{t("traceToolGap")} · {ms(request.toolToProviderGapMs)}
							</p>
						</>
					)}
					{tool && (
						<>
							<p>
								{t("traceAssistantGap")} · {ms(tool.assistantToToolGapMs)}{" "}
								{tool.parentToolCallId && " · " + tool.parentToolCallId}
							</p>
							<button onClick={() => focusTool(entry)}>{t("wfZoomTool")}</button>
						</>
					)}
				</section>
			)}
		</section>
	);
}
