import { memo } from "react";
import type { UiCommandOutput } from "../types";
import { useT } from "../i18n";
import { CopyButton } from "./copy-button";

export const OmpCommandOutput = memo(function OmpCommandOutput({ output }: { output: UiCommandOutput }) {
	const t = useT();
	return <details className="omp-command-output" open>
		<summary>{t("ompCommandOutput")}</summary>
		<div className="omp-command-output-actions"><span>{t("ompCommandOutputTemporary")}</span><CopyButton text={output.text} label /></div>
		{output.truncated && <p className="omp-command-output-truncated">{t("ompCommandOutputTruncated")}</p>}
		<pre>{output.text}</pre>
	</details>;
});
