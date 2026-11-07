/** A separate request lane: polling must never cancel a query or overwrite a newer mutation. */
export function startDatabaseSync<T>(options: {
	request: (signal: AbortSignal) => Promise<T>;
	canStart: () => boolean;
	revision: () => number;
	receive: (value: T) => void;
	error: (error: unknown) => void;
}) {
	let stopped = false, pending: AbortController | undefined;
	async function refresh() {
		if (stopped || pending || !options.canStart()) return;
		const controller = new AbortController(), revision = options.revision(); pending = controller;
		const current = () => !stopped && pending === controller && revision === options.revision();
		const timeout = setTimeout(() => { if (current()) options.error(Error("Source synchronization timed out")); controller.abort(); pending = undefined; }, 10000);
		controller.signal.addEventListener("abort", () => clearTimeout(timeout), { once: true });
		try { const result = await options.request(controller.signal); if (current() && !controller.signal.aborted) options.receive(result); }
		catch (error) { if (current() && !controller.signal.aborted) options.error(error); }
		finally { clearTimeout(timeout); if (pending === controller) pending = undefined; }
	}
	const interval = setInterval(() => void refresh(), 15000);
	void refresh();
	return { refresh, stop() { stopped = true; clearInterval(interval); pending?.abort(); pending = undefined; } };
}
