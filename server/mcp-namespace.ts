export function mcpNamespaceKey(name: string): string {
	return name.replace(/-/g, "_");
}

/** Older releases stored this built-in Chrome bridge under either spelling. */
export function retiredBrowserServer(name: string): boolean {
	return mcpNamespaceKey(name) === "playwright_extension";
}
