import { afterEach, expect, it, vi } from "vitest";
import { desktopControl, desktopGrant, toggleDesktop } from "../../server/desktop-control.js";

afterEach(() => { vi.unstubAllEnvs(); });
it.skipIf(!["darwin", "win32"].includes(process.platform))("scopes desktop consent to the current session and cancels it on revoke or rotation", () => {
	vi.stubEnv("PI_WEB_HOST", "127.0.0.1");
	let id = "first";
	const owner = { getSessionId: () => id };
	const initial = desktopGrant(owner);
	expect(initial.controller).toBeUndefined();
	toggleDesktop(owner, true, initial.version);
	const enabled = desktopGrant(owner);
	expect(enabled.controller?.signal.aborted).toBe(false);
	expect(() => toggleDesktop(owner, false, initial.version)).toThrow();
	id = "second";
	const next = desktopGrant(owner);
	expect(next.controller).toBeUndefined();
	expect(enabled.controller?.signal.aborted).toBe(true);
	toggleDesktop(owner, true, next.version);
	const active = desktopGrant(owner);
	toggleDesktop(owner, false, active.version);
	expect(active.controller?.signal.aborted).toBe(true);
	expect(desktopGrant(owner).controller).toBeUndefined();
});
it("rejects desktop access when listening on the network", () => {
	vi.stubEnv("PI_WEB_HOST", "0.0.0.0");
	const owner = { getSessionId: () => "remote" };
	expect(() => toggleDesktop(owner, true, desktopGrant(owner).version)).toThrow();
});
it.skipIf(!["darwin", "win32"].includes(process.platform))("pre-authorizes later conversations once the service default is applied", () => {
	vi.stubEnv("PI_WEB_HOST", "127.0.0.1");
	let id = "first";
	const owner = { getSessionId: () => id };
	const initial = desktopGrant(owner);
	expect(initial.controller).toBeUndefined();
	toggleDesktop(owner, true, initial.version);
	// The factory runs after this grant was looked up: the service default must still apply.
	desktopControl(owner, true)({ registerTool: () => {} } as never);
	expect(desktopGrant(owner).controller).toBeDefined();
	id = "second";
	expect(desktopGrant(owner).controller).toBeDefined();
	const other = { getSessionId: () => "plain" };
	expect(desktopGrant(other).controller).toBeUndefined();
	desktopControl(owner, false)({ registerTool: () => {} } as never);
	id = "third";
	expect(desktopGrant(owner).controller).toBeUndefined();
});
it.skipIf(!["darwin", "win32"].includes(process.platform))("keeps an explicit revocation from being undone by the service default", () => {
	vi.stubEnv("PI_WEB_HOST", "127.0.0.1");
	const owner = { getSessionId: () => "revoked" };
	desktopControl(owner, true)({ registerTool: () => {} } as never);
	expect(desktopGrant(owner).controller).toBeDefined();
	toggleDesktop(owner, false, desktopGrant(owner).version);
	expect(desktopGrant(owner).controller).toBeUndefined();
});
it.skipIf(!["darwin", "win32"].includes(process.platform))("keeps the default unusable off loopback even when switched on", () => {
	vi.stubEnv("PI_WEB_HOST", "0.0.0.0");
	const owner = { getSessionId: () => "remote-on" };
	desktopControl(owner, true)({ registerTool: () => {} } as never);
	desktopGrant(owner);
	expect(desktopGrant(owner).controller).toBeUndefined();
});
