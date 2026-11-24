/** Running work breathes green. */
export function RunningIndicator({ label }: { label?: string }) {
	return <span className="bash-running-dot running-indicator" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}
