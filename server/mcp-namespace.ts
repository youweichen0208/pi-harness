export function mcpNamespaceKey(name: string): string {
	return name.replace(/-/g, "_");
}
