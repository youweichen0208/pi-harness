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
5. Report Created, Updated, Unchanged, Skipped, or Conflict for each candidate, distinguishing conflicting knowledge content from a file version conflict, which requires rereading the document and reconciling before retrying. Present meaningful changes and save only through `knowledge_write`.

## Knowledge Quality

- Assign status according to the evidence supporting material claims, not merely the presence of a source.
- Use `verified` for claims supported by sufficient direct evidence or explicit user-confirmed decisions. A confirmed decision does not establish implementation correctness.
- Use `inferred` for reasoned conclusions without direct verification, and `unverified` for unsupported hypotheses.
- For mixed-evidence documents, use the weakest material claim as the document status and distinguish evidence levels in the body.
- Split documents only when the resulting entries have independent knowledge value.
- Preserve existing valid knowledge and provenance when merging new information.
- Never promote a claim to `verified` solely because the model or user requests that label.
- Report unresolved knowledge conflicts and version conflicts explicitly. Never overwrite conflicting content silently.

## Rules

- Keep domain knowledge, architecture, troubleshooting, best practices, and durable decisions. Skip temporary context, one-off diagnostics, and low-value observations.
- Do not produce a transcript summary or one document per discussed topic.
- Assign status by the Knowledge Quality rules; do not invent numeric confidence.
- Route improvements to agent workflows to Reflect and project documentation updates to Knowledge Sync. Do not modify Skills.
- Do not scan other sessions, learn automatically after Engineering, or write outside the configured knowledge library.
