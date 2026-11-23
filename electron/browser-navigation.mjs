// One controller per WebContents. Keep the original deep link for an explicit retry.
// Only the origin and pathname are returned in diagnostics.
export function trackBrowserNavigation(wc, validate, changed) {
	let pending, currentUrl, retryUrl, failure;
	const interrupted = { status: "interrupted", message: "Navigation interrupted. Read the active tab to check its current page." };
	const sameDocumentUrl = (a, b) => a?.split("#")[0] === b?.split("#")[0];

	function finish(result) {
		const request = pending;
		pending = undefined;
		request?.signal?.removeEventListener("abort", request.cancel);
		request?.resolve(result);
	}
	function fail(code, target) {
		let displayUrl = "";
		try {
			const u = new URL(target);
			if (["http:", "https:"].includes(u.protocol)) displayUrl = u.origin + u.pathname;
		} catch { /* The submitted address can be malformed. */ }
		retryUrl = code === "UNSUPPORTED_URL" ? undefined : pending?.target || target;
		failure = { ok: false, code, url: displayUrl, canRetry: !!retryUrl };
		finish(failure);
		changed();
		return failure;
	}
	function start(event) {
		if (!event.isMainFrame) return;
		currentUrl = event.url;
		failure = retryUrl = undefined;
		changed();
	}
	wc.on("did-start-navigation", start);
	wc.on("did-redirect-navigation", start);
	wc.on("did-fail-load", (_event, errno, description, target, main) => {
		if (main && errno !== -3 && sameDocumentUrl(target, currentUrl) && !failure)
			fail(/^ERR_[A-Z0-9_]+$/.test(description) ? description : "ERR_FAILED", target);
	});
	function loaded(target) {
		if (!failure && sameDocumentUrl(target, currentUrl)) finish({ ok: true });
	}
	wc.on("did-finish-load", () => loaded(wc.getURL()));
	wc.on("did-navigate-in-page", (_event, target, main) => { if (main) loaded(target); });
	wc.on("did-stop-loading", () => {
		if (pending?.aborted && !wc.isLoadingMainFrame()) finish(interrupted);
	});
	wc.once("destroyed", () => finish(interrupted));

	function go(value, signal) {
		finish(interrupted);
		let target;
		try { target = validate(value); }
		catch { return Promise.resolve(fail("UNSUPPORTED_URL", value)); }
		failure = retryUrl = undefined;
		currentUrl = target;
		changed();
		return new Promise(resolve => {
			const request = { target, resolve, aborted: false, signal, cancel: () => finish(interrupted) };
			pending = request;
			if (signal?.aborted) { finish(interrupted); return; }
			signal?.addEventListener("abort", request.cancel, { once: true });
			wc.loadURL(target).then(() => {
				if (pending !== request) return;
				if (sameDocumentUrl(wc.getURL(), currentUrl)) finish({ ok: true });
				else finish(interrupted);
			}, error => {
				if (pending !== request) return;
				if (error.errno === -3 || error.code === "ERR_ABORTED") {
					request.aborted = true;
					if (!wc.isLoadingMainFrame()) finish(interrupted);
				} else {
					fail(/^ERR_[A-Z0-9_]+$/.test(error.code) ? error.code : "ERR_FAILED", currentUrl);
				}
			});
		});
	}
	return {
		go,
		get failure() { return failure; },
		retry() { if (retryUrl) return go(retryUrl); },
		block(target) { fail("UNSUPPORTED_URL", target); },
	};
}
