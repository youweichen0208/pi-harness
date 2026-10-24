import { copyText } from "../clipboard";
import { memo, useEffect, useRef, useState } from "react";
import { FiCheck, FiCopy } from "react-icons/fi";
import { useT } from "../i18n";

export const CopyButton = memo(function CopyButton({ text, label = false }: { text: string; label?: boolean }) {
	const t = useT();
	const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
	const timer = useRef<ReturnType<typeof setTimeout>>();
	const attempt = useRef(0);
	useEffect(() => () => { clearTimeout(timer.current); attempt.current++; }, []);
	if (!text) return null;
	const title = t(status === "copied" ? "copied" : status === "failed" ? "copyFailed" : "copy");
	return (
		<button
			type="button"
			className="copy-btn"
			title={title}
			aria-label={title}
			onClick={event => {
				const id = ++attempt.current;
				clearTimeout(timer.current);
				const finish = (next: "copied" | "failed") => {
					if (id !== attempt.current) return;
					setStatus(next);
					timer.current = setTimeout(() => setStatus("idle"), next === "failed" ? 4000 : 1200);
				};
				void copyText(text, event.currentTarget.ownerDocument).then(() => finish("copied"), () => finish("failed"));
			}}
		>
			{status === "copied" ? <FiCheck /> : <FiCopy />}{(label || status === "failed") && <span role="status">{title}</span>}
		</button>
	);
});
