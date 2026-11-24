import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { marked, Tokenizer } from "./vendor/marked.mjs";

const [command, file] = process.argv.slice(2);
if (!["fingerprint", "verify"].includes(command) || !file) {
	console.error("Usage: node approval-fingerprint.mjs fingerprint|verify <change.md>");
	process.exit(64);
}

function inlineText(token) {
	if (token.type === "html") return "";
	if (token.tokens) return token.tokens.map(inlineText).join("");
	return token.text ?? "";
}

const protectedSections = ["Goal", "Design", "Acceptance Criteria"];

class ApprovalTokenizer extends Tokenizer {
	def(source) {
		const definition = super.def(source);
		if (definition && this.lexer.tokens.links[definition.tag]) {
			// Keep a duplicate's raw block without replacing the first definition.
			// A Symbol key cannot be resolved by any Markdown reference label.
			definition.tag = Symbol(definition.tag);
		}
		return definition;
	}

	reflink(source, definitions) {
		const token = super.reflink(source, definitions);
		if (!token) return;
		// Keep an unresolved label distinct from adjacent text. An older approval
		// could have used this label before its document-level definition was removed.
		if (token.type === "text") token.type = "unresolvedReference";
		token.isReference = true;
		return token;
	}
}

function readSections(markdown) {
	const source = markdown.replace(/\r\n?/g, "\n");
	const blocks = marked.lexer(source, { ...marked.defaults, tokenizer: new ApprovalTokenizer() });
	if (blocks.map(block => block.raw).join("") !== source) throw Error("Cannot locate the exact Markdown source");
	const sections = new Map();
	let current;
	for (const block of blocks) {
		if (block.type !== "heading" || block.depth > 2) {
			current?.push(block);
			continue;
		}

		current = undefined;
		const name = inlineText(block).trim();
		if (block.depth === 2 && (protectedSections.includes(name) || name === "Approval")) {
			if (sections.has(name)) throw Error(`Duplicate section: ${name}`);
			current = [];
			sections.set(name, current);
		}
	}
	return sections;
}

function section(sections, name) {
	const blocks = sections.get(name);
	if (!blocks) throw Error(`Missing section: ${name}`);
	return blocks;
}

// Only a real, top-level task's completion marker is mutable after approval.
function acceptanceSource(block) {
	if (block.type !== "list") return block.raw;
	let source = "", offset = 0;
	for (const item of block.items) {
		if (!block.raw.startsWith(item.raw, offset)) throw Error("Cannot locate the exact acceptance list item");
		source += item.task ? item.raw.replace(/^( {0,3}(?:[-+*]|\d+[.)])[ \t]+)\[[xX]\]/, "$1[ ]") : item.raw;
		offset += item.raw.length;
	}
	return source + block.raw.slice(offset);
}

function fingerprint(sections) {
	const references = [];
	const content = protectedSections.map(name => {
		const blocks = section(sections, name);
		marked.walkTokens(blocks, token => {
			if (token.isReference) references.push([token.raw, token.href, token.title]);
		});
		const raw = blocks.map(block => name === "Acceptance Criteria" ? acceptanceSource(block) : block.raw).join("");
		// Preserve exact examples, including the first line's indent and trailing spaces.
		return raw.replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, "");
	});
	// Keep existing fingerprints when the contract does not use reference syntax.
	if (references.length) content.push(references);
	return createHash("sha256").update(JSON.stringify(content)).digest("hex");
}

function field(blocks, name) {
	const values = [], prefix = `${name}:`;
	for (const block of blocks) {
		if (block.type !== "paragraph") continue;
		const lines = block.raw.split("\n");
		const visible = block.tokens.map(token => {
			if (token.type === "text") return token.raw;
			// Keep source line numbers. Inline markup may supply the value, but a
			// field label must begin an actual line of ordinary paragraph text.
			const breaks = token.raw.split("\n").length - 1;
			return inlineText(token).replace(/\n/g, " ") + "\n".repeat(breaks);
		}).join("").split("\n");
		for (const [index, line] of visible.entries()) {
			if (lines[index]?.startsWith(prefix) && line.startsWith(prefix)) values.push(line.slice(prefix.length).trim());
		}
	}
	if (values.length > 1) throw Error(`Conflicting duplicate field: ${name}`);
	return values[0] ?? "";
}

try {
	const sections = readSections(readFileSync(file, "utf8"));
	const current = fingerprint(sections);
	if (command === "fingerprint") console.log(current);
	else {
		const approval = section(sections, "Approval");
		const status = field(approval, "Status"), design = field(section(sections, "Design"), "Design revision"), approved = field(approval, "Approved revision");
		const recorded = field(approval, "Approved content SHA-256"), evidence = field(approval, "Evidence");
		if (status !== "approved" || !approved || approved === "none" || !/^[a-f0-9]{64}$/.test(recorded) || !evidence || /^(none|no user confirmation recorded)$/i.test(evidence)) {
			console.log("NEEDS_CONFIRMATION missing approval evidence or content fingerprint");
			process.exit(2);
		}
		if (design !== approved || recorded !== current) {
			console.log(`STALE approved content does not match current Goal, Design, and Acceptance Criteria (expected ${recorded}, current ${current})`);
			process.exit(3);
		}
		console.log(`APPROVED revision ${approved}, content ${current}`);
	}
} catch (error) {
	if (command === "verify") {
		console.log(`NEEDS_CONFIRMATION ${error instanceof Error ? error.message : String(error)}`);
		process.exit(2);
	}
	throw error;
}
