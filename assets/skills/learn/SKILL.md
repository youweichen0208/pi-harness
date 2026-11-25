---
name: learn
description: Distill durable knowledge from the current conversation and merge it into the configured Markdown knowledge library through an approved write. Invoke explicitly with /learn or /skill:learn.
disable-model-invocation: true
---

# Learn

Learn knowledge, not conversation summaries. Work in the user's language.

## Workflow

1. Review the accessible current branch and state if compaction makes it partial. Identify only durable, reusable knowledge supported by the conversation, code, documentation, tool results, or explicit user decisions.
2. Search the existing knowledge library before creating anything. Respect its current categories and prefer updating an existing entry over creating a duplicate.
3. Ground material claims. Distinguish verified facts, inference, and unresolved hypotheses. Reading a file does not verify every claim in an article.
4. Merge into focused knowledge entries while preserving unrelated metadata and prose. Record sources, applicability, and uncertainty. Never invent evidence.
5. Report Created, Updated, Unchanged, Conflict, or Skipped for each candidate. Present meaningful changes and save only through `knowledge_write`.

## Rules

- Keep domain knowledge, architecture, troubleshooting, best practices, and durable decisions. Skip temporary context, one-off diagnostics, and low-value observations.
- Do not produce a transcript summary or one document per discussed topic.
- Use `verified`, `inferred`, or `unverified` for the claims actually supported; do not invent numeric confidence.
- Route improvements to agent workflows to Reflect and project documentation updates to Knowledge Sync. Do not modify Skills.
- Do not scan other sessions, learn automatically after Engineering, or write outside the configured knowledge library.
