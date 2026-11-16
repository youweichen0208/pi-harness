import { expect, it, vi } from "vitest";
import type { OmpRuntimeOptions } from "../../server/omp/runtime.js";

const fixture = `
const readline = require('node:readline');
const send = frame => process.stdout.write(JSON.stringify(frame)+'\\n');
const model = {provider:'fixture',id:'model',contextWindow:200000,maxTokens:16384};
let armed = false, catalogArmed = false, sessionFile = '/history/original.jsonl', sessionId = 'original';
let holdRefresh = false, releaseRefresh, changeAttempts = 0;
let holdChange = false, releaseChange, refreshDuringChange = 0;
readline.createInterface({input:process.stdin}).on('line', line => {
 const frame = JSON.parse(line), reply = data => send({type:'response',id:frame.id,command:frame.type,success:true,data});
 if (frame.type === 'arm_refresh_hold') { holdRefresh = true; return reply({}); }
 if (frame.type === 'release_refresh') { releaseRefresh?.(); releaseRefresh = undefined; return reply({}); }
 if (frame.type === 'fixture_changes') return reply({changeAttempts});
 if (frame.type === 'arm_change_hold') { holdChange = true; return reply({}); }
 if (frame.type === 'release_change') { releaseChange?.(); releaseChange = undefined; return reply({}); }
 if (frame.type === 'fixture_overlap') return reply({refreshDuringChange});
 if (frame.type === 'harness_sync_skills' && releaseChange) refreshDuringChange++;
 if (frame.type === 'harness_sync_skills' && holdRefresh) {
  holdRefresh = false; releaseRefresh = () => reply({});
  return send({type:'fixture_refresh_waiting'});
 }
 if (frame.type === 'set_model' || frame.type === 'set_thinking_level') {
  changeAttempts++; send({type:'fixture_native_change',command:frame.type});
  if (releaseRefresh) return send({type:'response',id:frame.id,command:frame.type,success:false,error:'OMP configuration operation in progress'});
  if (holdChange) { holdChange = false; releaseChange = () => reply({}); return send({type:'fixture_change_waiting'}); }
  return reply({});
 }
 if (frame.type === 'arm_race') { armed = true; return reply({}); }
 if (frame.type === 'arm_catalog_race') { catalogArmed = true; return reply({}); }
 if (frame.type === 'get_available_commands') {
  const data = {commands:[{name:'old-command',source:'extension'}]};
  if (!catalogArmed) return reply(data);
  catalogArmed = false;
  send({type:'available_commands_update',commands:[{name:'new-command',source:'mcp_prompt'}]});
  return setTimeout(() => reply(data), 30);
 }
 if (frame.type === 'get_state') {
  const data = {sessionFile,sessionId,model,isSettled:true,dumpTools:[],queuedMessages:{}};
  if (!armed) return reply(data);
  armed = false; sessionFile = '/history/relocated.jsonl'; sessionId = 'relocated';
  send({type:'harness_persistence',persistence:{failed:false,relocation:{reason:'open-elsewhere',fromFile:data.sessionFile,toFile:sessionFile}}});
  return setTimeout(() => reply(data), 30);
 }
 if (frame.type === 'harness_history') return reply({messages:[],entryIds:[],tasks:[],persistence:{failed:false}});
 if (frame.type === 'get_available_models') return reply({models:[model]});
 if (frame.type === 'get_subagents') return reply({subagents:[]});
 reply({});
});`;
vi.mock("../../server/omp/runtime.js", async () => {
	const { OmpTransport } = await import("../../server/omp/transport.js");
	return {
		createOmpRuntime: async (options: OmpRuntimeOptions) => {
			const runtime = new OmpTransport({ conversationId: options.conversationId, executable: process.execPath, args: ["-e", fixture], cwd: process.cwd(), env: {}, onEvent: options.onEvent, onExit: options.onExit });
			options.onTransport?.(runtime);
			return runtime;
		},
		stopOmpRuntime: async (runtime: InstanceType<typeof OmpTransport>) => runtime.close(),
	};
});
import { OmpSession } from "../../server/omp/session.js";

it("does not let a pending metadata read undo a newer native relocation", async () => {
	const session = new OmpSession({ conversationId: "race", dataDir: "/unused", cwd: process.cwd(), onChange() {} });
	try {
		await session.open();
		expect(session.state.sessionFile).toBe("/history/original.jsonl");
		await session.command("arm_race");
		await session.refresh();
		expect(session.state.persistence?.relocation?.toFile).toBe("/history/relocated.jsonl");
		expect(session.state.sessionFile).toBe("/history/relocated.jsonl");
		await session.refresh();
		expect(session.state.sessionId).toBe("relocated");
	} finally { await session.close(); }
});

it("keeps a native command update newer than an outstanding catalogue response, including after Stop", async () => {
	const session = new OmpSession({ conversationId: "commands", dataDir: "/unused", cwd: process.cwd(), onChange() {} });
	try {
		await session.open();
		await session.readMetadata("get_available_commands");
		expect(session.commandCatalog).toEqual([{ name: "old-command", source: "extension" }]);
		await session.command("arm_catalog_race");
		const response = await session.readMetadata("get_available_commands");
		expect(response?.data).toEqual({ commands: [{ name: "new-command", source: "mcp_prompt" }] });
		await session.stop();
		expect((await session.readMetadata("get_available_commands"))?.data).toEqual(response?.data);
		expect(session.generation).toBeUndefined();
	} finally { await session.close(); }
});

it.each(["model", "thinking"])("waits for an in-flight passive refresh before changing %s", async kind => {
	const session = new OmpSession({ conversationId: `refresh-${kind}`, dataDir: "/unused", cwd: process.cwd(), onChange() {} });
	let refresh: Promise<void> | undefined, changed: Promise<unknown> | undefined;
	try {
		await session.open();
		const waiting = new Promise<void>(resolve => session.subscribe(frame => { if (frame.type === "fixture_refresh_waiting") resolve(); }));
		await session.command("arm_refresh_hold"); refresh = session.refresh(); await waiting;
		changed = (kind === "model" ? session.setModel("fixture", "model") : session.setThinking("low")).catch(error => error);
		const counters = await session.command("fixture_changes");
		expect(counters.data).toEqual({ changeAttempts: 0 });
		await session.command("release_refresh"); await refresh;
		expect(await changed).toBeUndefined();
		expect((await session.command("fixture_changes")).data).toEqual({ changeAttempts: 1 });
	} finally {
		await session.command("release_refresh", {}, { open: false }).catch(() => {});
		await Promise.allSettled([refresh, changed]); await session.close();
	}
});

it.each(["model", "thinking"])("Stop cancels a %s change waiting for metadata without reopening the worker", async kind => {
	const session = new OmpSession({ conversationId: `stop-refresh-${kind}`, dataDir: "/unused", cwd: process.cwd(), onChange() {} });
	const changes: unknown[] = [];
	try {
		await session.open();
		const waiting = new Promise<void>(resolve => session.subscribe(frame => {
			if (frame.type === "fixture_refresh_waiting") resolve();
			if (frame.type === "fixture_native_change") changes.push(frame);
		}));
		await session.command("arm_refresh_hold"); const refresh = session.refresh(); await waiting;
		const changed = (kind === "model" ? session.setModel("fixture", "model") : session.setThinking("low")).catch(error => error);
		await session.command("fixture_changes");
		await session.stop(); await refresh;
		expect(await changed).toBeInstanceOf(Error);
		expect(changes).toEqual([]);
		expect(session.generation).toBeUndefined();
	} finally { await session.close(); }
});

it.each(["model", "thinking"])("defers a new passive refresh until a pending %s change is acknowledged", async kind => {
	const session = new OmpSession({ conversationId: `change-${kind}`, dataDir: "/unused", cwd: process.cwd(), onChange() {} });
	let refresh: Promise<void> | undefined, changed: Promise<void> | undefined;
	try {
		await session.open();
		const waiting = new Promise<void>(resolve => session.subscribe(frame => { if (frame.type === "fixture_change_waiting") resolve(); }));
		await session.command("arm_change_hold");
		changed = kind === "model" ? session.setModel("fixture", "model") : session.setThinking("low");
		await waiting; refresh = session.refresh();
		expect((await session.command("fixture_overlap")).data).toEqual({ refreshDuringChange: 0 });
		await session.command("release_change"); await changed; await refresh;
		expect((await session.command("fixture_overlap")).data).toEqual({ refreshDuringChange: 0 });
	} finally {
		await session.command("release_change", {}, { open: false }).catch(() => {});
		await Promise.allSettled([refresh, changed]); await session.close();
	}
});
