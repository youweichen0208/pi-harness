/**
 * Playground configuration — one global, server-side switch plus the Run limits.
 *
 * The switch is deliberately global rather than a per-client UI preference: a
 * per-client toggle could be turned on by anyone who can open the page, which
 * would make "off by default" meaningless. `PI_WEB_PLAYGROUND=off` locks it off
 * on top of the file, for deployments where the file itself is page-writable.
 *
 * Pure: no I/O, no environment reads beyond the map handed in. The store at the
 * bottom of this file is the only I/O, kept here so the shape and the file live
 * together.
 */

import { readFileSync } from "node:fs";
import { writeFileAtomic } from "./private-file.js";

export interface PlaygroundConfig {
	enabled: boolean;
	timeoutMs: number;
	maxOutputBytes: number;
	maxHeapMb: number;
	maxConcurrent: number;
}

export const PLAYGROUND_DEFAULTS: Readonly<PlaygroundConfig> = Object.freeze({
	enabled: false,
	timeoutMs: 10000,
	maxOutputBytes: 262144,
	maxHeapMb: 256,
	maxConcurrent: 2,
});

/** Inclusive bounds for every numeric field; out-of-range values are clamped, not rejected. */
const BOUNDS: Readonly<Record<"timeoutMs" | "maxOutputBytes" | "maxHeapMb" | "maxConcurrent", readonly [number, number]>> = {
	timeoutMs: [1000, 60000],
	maxOutputBytes: [1024, 16 * 1024 * 1024],
	maxHeapMb: [16, 4096],
	maxConcurrent: [1, 8],
};

function bounded(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/**
 * Coerce whatever was on disk into a usable config. A corrupt, partial or
 * hand-edited file must degrade to the defaults rather than crash a request.
 */
export function normalizePlaygroundConfig(value: unknown): PlaygroundConfig {
	const raw = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	return {
		enabled: raw.enabled === true,
		timeoutMs: bounded(raw.timeoutMs, BOUNDS.timeoutMs, PLAYGROUND_DEFAULTS.timeoutMs),
		maxOutputBytes: bounded(raw.maxOutputBytes, BOUNDS.maxOutputBytes, PLAYGROUND_DEFAULTS.maxOutputBytes),
		maxHeapMb: bounded(raw.maxHeapMb, BOUNDS.maxHeapMb, PLAYGROUND_DEFAULTS.maxHeapMb),
		maxConcurrent: bounded(raw.maxConcurrent, BOUNDS.maxConcurrent, PLAYGROUND_DEFAULTS.maxConcurrent),
	};
}

/** True when the environment forces the Playground off and locks the setting. */
export function playgroundEnvLock(env: Readonly<Record<string, string | undefined>>): boolean {
	const value = env.PI_WEB_PLAYGROUND?.trim().toLowerCase();
	return value === "off" || value === "0" || value === "false";
}

/**
 * The global switch on disk (`<dataDir>/playground.json`). A missing or corrupt
 * file reads as the defaults: this is a safety switch, so failing open would be
 * the wrong direction — failing closed means "off".
 */
export class PlaygroundConfigStore {
	constructor(private readonly file: string) {}

	read(): PlaygroundConfig {
		try {
			return normalizePlaygroundConfig(JSON.parse(readFileSync(this.file, "utf8")));
		} catch {
			return normalizePlaygroundConfig(undefined);
		}
	}

	write(config: PlaygroundConfig): PlaygroundConfig {
		const next = normalizePlaygroundConfig(config);
		writeFileAtomic(this.file, JSON.stringify(next));
		return next;
	}
}
