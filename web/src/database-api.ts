import { withToken } from "./auth-token";
import { getClientId } from "./use-chat";
import { randomUuid } from "./uuid";
import type { DatabaseOperation, DatabaseResponse } from "./types";
export async function databaseRequest(cwd: string, conversationId: string, operation: DatabaseOperation, signal?: AbortSignal, requestId = randomUuid()): Promise<DatabaseResponse> {
	const response = await fetch(withToken("/api/database"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...operation, clientId: getClientId(), cwd, conversationId, requestId }), signal });
	const result: DatabaseResponse = await response.json();
	if (!response.ok || result.error) throw Error(result.error ?? response.statusText);
	if (result.requestId !== requestId) throw Error("Database response mismatch");
	return result;
}
