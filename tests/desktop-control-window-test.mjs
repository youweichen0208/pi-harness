// Local interactive regression. Requires the installed helper, Chrome and screen capture permission.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { desktopControl, desktopGrant, toggleDesktop } from "../dist/server/desktop-control.js";

const title = `pi-window-${randomUUID()}`;
const owner = { getSessionId: () => title };
let tool;
desktopControl(owner)({ registerTool: definition => { tool = definition; } });
const call = args => tool.execute("window-test", args);
await assert.rejects(call({action: "list"}), /Enable desktop control/);
toggleDesktop(owner, true, desktopGrant(owner).version);
await assert.rejects(call({action: "click", x: 1, y: 1, snapshot: "stale"}), /View the target/);
const browser = await chromium.launch({ channel: "chrome", headless: false });
try {
	const page = await browser.newPage();
	await page.setContent(`<title>${title}</title><table><tr><td>Revenue</td><td>371</td></tr></table>`);
	await page.bringToFront();
	const windows = JSON.parse((await call({action: "list"})).content[0].text);
	const target = windows.find(row => row.title.includes(title));
	assert.ok(target, "fixture window listed");
	const result = await call({action: "view", id: target.id});
	assert.equal(result.content[1].mimeType, "image/jpeg");
	assert.equal(Buffer.from(result.content[1].data, "base64").readUInt16BE(), 0xffd8);
	toggleDesktop(owner, false, desktopGrant(owner).version);
	await assert.rejects(call({action: "type", text: "test", snapshot: JSON.parse(result.content[0].text).snapshot}), /Enable desktop control/);
	console.log("PASS desktop capture, stale action rejection and revocation");
} finally {
	await browser.close();
}
