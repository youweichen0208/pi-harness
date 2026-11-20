// Shared by browser settings and project override validation.
export const browserMcpName = "playwright-extension";
export const browserMcpConfig = {
	command: "npx",
	// Keep npm package resolution independent of the opened project. Pi expands "~".
	args: ["--prefix", "~", "--prefer-offline", "--ignore-scripts", "-y", "@playwright/mcp@0.0.86", "--extension"],
};
