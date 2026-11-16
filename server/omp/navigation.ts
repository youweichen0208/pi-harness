/** A navigation lease prevents asynchronous edits from crossing product conversations. */
export class OmpNavigationBusyError extends Error {
	constructor() { super("A conversation change is already in progress"); }
}
export class OmpNavigation {
	constructor(private changed = () => {}) {}
	private owner?: symbol;
	private epoch = 0;
	get busy() { return this.owner !== undefined; }
	cancel() { this.epoch++; }
	checkpoint() {
		const epoch = this.epoch;
		return () => { if (epoch !== this.epoch) throw Error("Conversation operation cancelled"); };
	}
	assertAvailable(lease?: symbol) {
		if (this.owner && this.owner !== lease) throw new OmpNavigationBusyError();
	}
	async run<T>(valid: () => boolean, action: (assertCurrent: () => void, lease: symbol) => Promise<T>): Promise<T> {
		this.assertAvailable();
		const lease = Symbol(), epoch = this.epoch;
		this.owner = lease;
		this.changed();
		const assertCurrent = () => {
			if (!valid() || epoch !== this.epoch || this.owner !== lease) throw Error("Conversation operation cancelled");
		};
		try { assertCurrent(); return await action(assertCurrent, lease); }
		finally { if (this.owner === lease) { this.owner = undefined; this.changed(); } }
	}
}
