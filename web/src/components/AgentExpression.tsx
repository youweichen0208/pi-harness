import { useEffect, useRef, useState } from "react";

export type AgentExpressionPose = "idle" | "waving" | "running" | "waiting" | "review" | "failed";

/** Decorative only: the adjacent existing status text remains authoritative. */
export function AgentExpression({ pose = "idle", active = false }: { pose?: AgentExpressionPose; active?: boolean }) {
	const element = useRef<HTMLSpanElement>(null);
	const [visible, setVisible] = useState(false);
	useEffect(() => {
		if (!active || !element.current) return;
		const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
		observer.observe(element.current);
		return () => observer.disconnect();
	}, [active]);
	return <span ref={element} className="agent-expression" aria-hidden="true" data-pose={pose} data-active={active ? "true" : "false"} data-animate={active && visible ? "true" : "false"} />;
}
