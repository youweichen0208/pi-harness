import { afterEach, expect, test, vi } from "vitest";
import { SubagentDetailRequest } from "../../web/src/subagent-detail-request.js";
import type { SubagentResponse, UiSubagentTaskDetail } from "../../server/protocol.js";
const task = { taskId: "task", sourceId: "repo", source: "Repo", root: "/repo", task: "Read", phase: "completed" as const };
function fixture() {
	vi.useFakeTimers();
	const send = vi.fn(), receive = vi.fn(), error = vi.fn();
	const loader = new SubagentDetailRequest("task", send, receive, error);
	const respond = (detail: Partial<UiSubagentTaskDetail> = {}, id = send.mock.lastCall![0].requestId) => loader.response({ type: "subagent_response", requestId: id, conversationId: "conv", taskId: "task", detail: { task, events: [], truncated: false, ...detail } });
	return { loader, send, receive, error, respond };
}
afterEach(() => vi.useRealTimers());
test("terminal first-load loss retries once at ten seconds then waits for manual retry", () => {
	const { loader, send, error, respond, receive } = fixture();
	loader.request(); const expired = send.mock.lastCall![0].requestId;
	vi.advanceTimersByTime(10000); loader.tick();
	expect(send).toHaveBeenCalledTimes(2); expect(error).toHaveBeenLastCalledWith(true);
	respond({}, expired); expect(receive).not.toHaveBeenCalled();
	vi.advanceTimersByTime(10000); loader.tick(); loader.tick();
	expect(send).toHaveBeenCalledTimes(2);
	loader.retry(); respond(); loader.tick();
	expect(send).toHaveBeenCalledTimes(3); expect(error).toHaveBeenLastCalledWith(false);
});
test("pagination tolerates loss and duplicates, reconnect resumes cursor and close isolates stale replies", () => {
	const { loader, send, receive, respond } = fixture();
	loader.request();
	const event = { seq: 0, at: 0, type: "answer" as const, text: "first" };
	respond({ events: [event], nextCursor: 1 });
	expect(send.mock.lastCall![0].cursor).toBe(1);
	const old = send.mock.lastCall![0].requestId;
	loader.retry(); // Full snapshot after reconnect.
	expect(send.mock.lastCall![0].cursor).toBe(1);
	respond({ events: [{ ...event, seq: 1 }] }, old); expect(receive).toHaveBeenCalledTimes(1);
	respond({ events: [event, { ...event, seq: 1 }] });
	expect(receive.mock.lastCall![0].events.map((event: { seq: number }) => event.seq)).toEqual([0, 1]);
	loader.close(); loader.retry(); respond();
	expect(receive).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(3);
});
test("stop and detail requests do not replace each other and stop is never replayed", () => {
	const { loader, send, respond, receive } = fixture();
	loader.request(); const detailId = send.mock.lastCall![0].requestId;
	loader.request("stop"); const stopId = send.mock.lastCall![0].requestId;
	respond({ task: { ...task, phase: "stopping" } }, stopId);
	expect(receive.mock.lastCall![0].task.phase).toBe("stopping");
	respond({}, detailId); expect(receive).toHaveBeenCalledTimes(2);
	vi.advanceTimersByTime(11000); loader.tick();
	expect(send.mock.calls.filter(call => call[0].action === "stop")).toHaveLength(1);
});
test("detail error preserves previous data until explicitly retried", () => {
	const { loader, send, respond, receive } = fixture();
	loader.request(); respond({ task: { ...task, phase: "running" } }); loader.tick();
	loader.response({ ...send.mock.lastCall![0], type: "subagent_response", conversationId: "conv", error: "missing" } as SubagentResponse);
	loader.tick(); expect(receive).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(2);
});
