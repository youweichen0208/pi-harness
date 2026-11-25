---
name: ask
description: Answer questions with evidence from the authorized Workspace repositories and Markdown knowledge library. Invoke explicitly with /ask or /skill:ask.
disable-model-invocation: true
---

# Ask

Answer with evidence. Work in the user's language and lead with the conclusion.

## Workflow

1. Determine the question and permitted sources. Start with direct search; do not inject a whole repository or knowledge library into context.
2. Locate relevant knowledge documents, project maps, glossaries, README files, and source entry points. Follow only the paths needed for the question.
3. For a known document, a single API or a short call chain, inspect the source directly. For independent repositories, a large module with distinct components, or a comparison across engines, use `knowledge_investigate` with up to three questions and their specific source IDs. Use only the sources permitted for this request.
4. Use child findings to locate key lines. Read those lines yourself with `source_read` and check the path, version and fingerprint. Treat missing, failed, stale or truncated investigations as evidence gaps.
5. Reconcile knowledge with current implementation. Prefer current code for current behavior while preserving historical context for design decisions.
6. Answer concisely with the sources actually inspected. Link verified lines using `[repository/path:line](#pi-evidence=<evidenceId>)` with the ID from your own read. Add call chains or diagrams only when they help a complex answer.

## Rules

- Search only relevant and authorized sources, including when the user excludes a source.
- Distinguish verified facts, inference, and unknowns. Report material search failures, truncation, stale evidence, and conflicting versions.
- Cite the exact source paths and line ranges supported by evidence; never invent citations or claim a broader search than performed.
- Do not modify files, run commands, invoke Learn automatically, or treat subagent summaries as verified without reading key evidence yourself.
