import { useT } from "../i18n";

/** Shared graph-paper welcome for normal chat and the document assistant. */
export function WelcomeMotto({ plain = false }: { plain?: boolean }) {
	const t = useT();
	return <div className={plain ? "welcome-paper welcome-plain" : "welcome-paper"}><h2 className="welcome-motto"><span>{t("welcomeMottoFirst")}</span><span>{t("welcomeMottoSecond")} <em>{t("welcomeMottoYours")}</em></span></h2></div>;
}
