import type { UiToolCallBlock } from "./protocol.js";

/** Native virtual resources (including OMP xd:// MCP routes) are not files.
 * Keep Windows drive paths, including forward-slash spelling, as real paths. */
export function isVirtualToolPath(path: string): boolean {
	const value = path.trim();
	return !/^[a-z]:[\\/]/i.test(value) && /^[a-z][a-z0-9+.-]*:\/\//i.test(value);
}

export function isVirtualToolCall(call: Pick<UiToolCallBlock, "name" | "argumentsText">): boolean {
	if (call.name !== "write" && call.name !== "read" && call.name !== "edit") return false;
	try {
		const args: unknown = JSON.parse(call.argumentsText ?? "{}");
		if (!args || typeof args !== "object") return false;
		const path = "path" in args ? args.path : "file_path" in args ? args.file_path : undefined;
		return typeof path === "string" && isVirtualToolPath(path);
	} catch { return false; }
}
