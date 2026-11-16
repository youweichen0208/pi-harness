/** Bun-only adaptation at the public RPC -> AgentSession.prompt boundary. */
import type { AgentSession } from "@oh-my-pi/pi-coding-agent";
import { expandPromptTemplate } from "@oh-my-pi/pi-coding-agent/config/prompt-templates";
import { expandSlashCommand, parseFileSlashInvocation } from "@oh-my-pi/pi-coding-agent/extensibility/slash-commands";
import { parseUserAttachments } from "../user-attachments.js";

/** Keep RPC's hooks, skill/builtin routing, admission and result tracking intact.
 * Only textual file/template expansion excludes complete host attachment blocks.
 * All SDK methods still execute on the original instance (including private fields);
 * neither the instance nor its prototype is mutated. */
export function rpcSessionWithAttachments(session: AgentSession): AgentSession {
	const prompt: AgentSession["prompt"] = async (text, options) => {
		if (options?.expandPromptTemplates === false || !text.startsWith("/")) return session.prompt(text, options);
		const parsed = parseUserAttachments(text);
		if (!parsed.attachments.length) return session.prompt(text, options);
		const invocation = parseFileSlashInvocation(parsed.text);
		if (!invocation) return session.prompt(text, options);
		// Executable extension/TypeScript/MCP commands precede file expansion.
		if (options?.runCommands !== false && (session.extensionRunner?.getCommand(invocation.name)
			|| session.customCommands.some(loaded => loaded.command.name === invocation.name))) return session.prompt(text, options);
		const fileCommand = session.slashCommands.some(command => command.name === invocation.name);
		const fileText = expandSlashCommand(parsed.text, session.slashCommands);
		const templateInvocation = parseFileSlashInvocation(fileText);
		const template = templateInvocation && session.promptTemplates.some(item => item.name === templateInvocation.name);
		if (!fileCommand && !template) return session.prompt(text, options);
		const expanded = expandPromptTemplate(fileText, [...session.promptTemplates]);
		// Native expansion is single-pass. A rendered leading slash is model text,
		// not another opportunity to run a command or parse attachment contents.
		return session.prompt([expanded, ...parsed.attachments.map(attachment => attachment.raw)].join("\n\n"), { ...options, expandPromptTemplates: false });
	};
	return new Proxy(session, {
		get(target, property) {
			if (property === "prompt") return prompt;
			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
		set(target, property, value) { return Reflect.set(target, property, value, target); },
	});
}
