import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { testEnv } from "./lib/test-env.mjs";

function check(source) {
	execFileSync(process.execPath, ["--input-type=module", "-e", `
		import assert from 'node:assert/strict';
		import {testEnv, scrubHostEnv} from ${JSON.stringify(new URL("./lib/test-env.mjs", import.meta.url).href)};
		${source}
	`], {
		env: { ...testEnv(), ANTHROPIC_API_KEY: "host-key", ANTHROPIC_AUTH_TOKEN: "host-token", ANTHROPIC_BASE_URL: "https://host.invalid", ANTHROPIC_MODEL: "host-model", OPENAI_API_KEY: "host-key", GEMINI_API_KEY: "host-key", HF_TOKEN: "host-token", COPILOT_GITHUB_TOKEN: "host-token", AWS_PROFILE: "host-profile", GOOGLE_APPLICATION_CREDENTIALS: "/host/credentials", GOOGLE_CLOUD_PROJECT: "host-project", GITHUB_TOKEN: "tooling-token", ELECTRON_RUN_AS_NODE: "1" },
		stdio: "pipe",
	});
}

test("child snapshots remove host model credentials/settings without mutating parent or tooling", () => {
	check(`
		const env = testEnv();
		for (const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','ANTHROPIC_MODEL','OPENAI_API_KEY','GEMINI_API_KEY','HF_TOKEN','COPILOT_GITHUB_TOKEN','AWS_PROFILE','GOOGLE_APPLICATION_CREDENTIALS','GOOGLE_CLOUD_PROJECT']) assert.equal(env[key], undefined, key);
		assert.equal(process.env.ANTHROPIC_API_KEY, 'host-key');
		assert.equal(env.GITHUB_TOKEN, 'tooling-token');
		assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
		assert.equal(testEnv({ANTHROPIC_API_KEY:'fixture-key'}).ANTHROPIC_API_KEY, 'fixture-key');
	`);
});

test("scrub clears host credentials once and preserves subsequent explicit fixture settings", () => {
	check(`
		scrubHostEnv();
		assert.equal(process.env.ANTHROPIC_API_KEY, undefined);
		assert.equal(process.env.ANTHROPIC_BASE_URL, undefined);
		process.env.ANTHROPIC_API_KEY = 'fixture-key';
		process.env.ANTHROPIC_BASE_URL = 'http://127.0.0.1:8999';
		const env = testEnv();
		assert.equal(env.ANTHROPIC_API_KEY, 'fixture-key');
		assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:8999');
		assert.equal(env.GITHUB_TOKEN, 'tooling-token');
	`);
});
