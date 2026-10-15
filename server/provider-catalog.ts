/** Presentation-only policy; never apply to persisted credentials or session models. */
export function isSelectableProvider(providerId: string): boolean {
	return providerId !== "openai-codex";
}
