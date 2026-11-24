import { useT } from "../i18n";

/** Shared welcome motto for normal chat and the document assistant. */
export function WelcomeMotto() {
	const t = useT();
	return <div className="welcome-paper"><h2 className="welcome-motto"><span>{t("welcomeMottoFirst")}</span><span>{t("welcomeMottoSecond")} <em>{t("welcomeMottoYours")}</em></span></h2></div>;
}
