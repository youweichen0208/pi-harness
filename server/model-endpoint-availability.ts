/** A credential makes a built-in model selectable, but an overridden endpoint
 * may not serve that provider's built-in catalog. Keep both Chat and Wiki
 * pickers aligned with the endpoint that will receive their requests. */
export function modelMatchesEndpoint(model: { provider: string; id: string }, anthropicBaseUrl: string | undefined): boolean {
	if (model.provider !== "anthropic" || !model.id.startsWith("claude-") || !anthropicBaseUrl) return true;
	try {
		const url = new URL(anthropicBaseUrl);
		const dashScopeHost = url.hostname === "dashscope.aliyuncs.com" || url.hostname === "dashscope-intl.aliyuncs.com" || url.hostname.endsWith(".dashscope.aliyuncs.com") || url.hostname.endsWith(".maas.aliyuncs.com");
		return !(dashScopeHost && url.pathname.replace(/\/$/, "") === "/apps/anthropic");
	} catch {
		return true;
	}
}
