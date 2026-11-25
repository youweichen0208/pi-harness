---
name: ask
description: Answer questions with evidence from the authorized Workspace repositories and Markdown knowledge library. Invoke explicitly with /ask or /skill:ask.
disable-model-invocation: true
---

# Ask

Answer with evidence. Work in the user's language and lead with the conclusion.

## Workflow

1. Identify the permitted sources. Read a known file directly. For a symbol or error code, search for its exact spelling. Use knowledge documents and project maps to find unfamiliar entry points.
2. Trace the question yourself by default, including across repositories. Follow each concrete lead (RPC method, event, task key) to its consumer or state writer before deciding where to look next.
3. Use `knowledge_investigate` only when a question can be checked independently, for example to test competing hypotheses in parallel, isolate a large self-contained investigation, or independently review a finding. Give each task its question, permitted source IDs and expected finding. Repository count, module size and cross-engine comparisons alone do not justify delegation.
4. Verify each material claim with your own `source_read` of the supporting lines. Check the path, version and fingerprint. Follow up on missing, stale or conflicting evidence and identify any remaining gaps.
5. Reconcile knowledge with current implementation. Prefer current code for current behavior while preserving historical context for design decisions.
6. Answer a direct question with the conclusion and its source. For a multi-step chain, explain how each handoff works and cite the original lines that establish it. When a diagram makes the chain easier to follow, use a fenced Mermaid block and put the evidence links in matching step order beneath it. Mark an unsupported hop as a gap or an inference.
7. For an incident, distinguish paths the code permits from the path observed for that incident. If the deployment version, task logs or metrics needed to decide are missing, say which observation would distinguish the plausible causes.

## Rules

- Search only relevant and authorized sources, including when the user excludes a source.
- Distinguish verified facts, inference, and unknowns. Report material search failures, truncation, stale evidence, and conflicting versions.
- Link the exact lines using `[repository/path:line](#pi-evidence=<evidenceId>)` and the ID issued by your own read.
- Do not modify files, run commands, invoke Learn automatically, or treat subagent summaries as verified without reading key evidence yourself.
