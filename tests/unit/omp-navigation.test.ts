import { expect, it } from "vitest";
import { OmpNavigation } from "../../server/omp/navigation.js";

it("rejects concurrent writes and invalidates awaited work when Stop arrives", async () => {
	const navigation = new OmpNavigation();
	let release!: () => void;
	const pending = new Promise<void>(resolve => { release = resolve; });
	const result = navigation.run(() => true, async (assertCurrent, lease) => {
		navigation.assertAvailable(lease);
		await pending; assertCurrent();
	});
	const rejected = expect(result).rejects.toThrow("cancelled");
	await expect(navigation.run(() => true, async () => {})).rejects.toThrow("in progress");
	expect(() => navigation.assertAvailable()).toThrow("in progress");
	const admission = navigation.checkpoint(); navigation.cancel();
	expect(() => admission()).toThrow("cancelled");
	release(); await rejected;
	expect(navigation.busy).toBe(false);
	await expect(navigation.run(() => true, async () => "new action")).resolves.toBe("new action");
});

it("releases ownership on conversation replacement and action failure", async () => {
	const navigation = new OmpNavigation();
	let valid = true;
	await expect(navigation.run(() => valid, async assertCurrent => { valid = false; assertCurrent(); })).rejects.toThrow("cancelled");
	expect(navigation.busy).toBe(false);
	await expect(navigation.run(() => true, async () => { throw Error("native failure"); })).rejects.toThrow("native failure");
	expect(navigation.busy).toBe(false);
});
