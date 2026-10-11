import { memo, useState } from "react";
import { LuCheck as FiCheck, LuCopy as FiCopy } from "react-icons/lu";
import { useT } from "../i18n";

export const CopyButton = memo(function CopyButton({ text, label = false }: { text: string; label?: boolean }) {
	const t = useT();
	const [copied, setCopied] = useState(false);
	if (!text) return null;
	return (
		<button
			type="button"
			className="copy-btn"
			title={t("copy")}
			onClick={() => {
				void navigator.clipboard.writeText(text).then(() => {
					setCopied(true);
					setTimeout(() => setCopied(false), 1200);
				});
			}}
		>
			{copied ? <FiCheck /> : <FiCopy />}{label && <span>{t("copy")}</span>}
		</button>
	);
});
