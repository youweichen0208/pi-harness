/** Running work breathes green; waiting for a reply retains the brand's three colors. */
export function RunningIndicator({ variant = "running", label }: { variant?: "running" | "waiting"; label?: string }) {
	return <span className={variant === "waiting" ? "waiting-brand" : "bash-running-dot running-indicator"} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>{variant === "waiting" && <><i /><i /><i /></>}</span>;
}
