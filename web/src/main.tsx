import { initAppearance } from "./appearance";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { LanguageProvider } from "./i18n";
// github-dark first so styles.css can retint tokens for the light appearance.
import "highlight.js/styles/github-dark.css";
import "./styles.css";
import { initAuthToken } from "./auth-token";
import { desktopAPI } from "./desktop";

document.documentElement.dataset.platform = desktopAPI?.platform ?? (/Windows/i.test(navigator.userAgent) ? "win32" : /Mac/i.test(navigator.userAgent) ? "darwin" : "linux");

// One shell class for every platform: the Windows/Linux chrome is styled exactly
// like macOS, so no rule is allowed to branch on the desktop OS again.
if (desktopAPI) document.documentElement.classList.add("pi-desktop");

// 吸收地址栏 ?token=（PI_WEB_TOKEN 鉴权入口）并持久化，须在首次请求前执行
initAuthToken();
initAppearance();

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<LanguageProvider>
			<App />
		</LanguageProvider>
	</StrictMode>,
);
