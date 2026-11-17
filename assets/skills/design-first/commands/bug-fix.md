---
description: Diagnose and fix a bug, run regression checks, and reconcile its spec
argument-hint: <bug description>
---

Use the Bug fix route of the bundled Design First skill. Read its instructions at this JSON-encoded path: {{DESIGN_FIRST_SKILL_PATH}}, then references/small-changes.md relative to that skill. The user has explicitly selected bug fixing; use the current session and model. Start with reproduction and expected/actual behavior, present the supported diagnosis and proposed fix for confirmation, then use native tools to implement, test and record the spec disposition. Respect existing authorization for a concrete fix. Keep local changes Quick; expand only when the observed impact warrants it.

User's bug report:
$ARGUMENTS

If the report is empty, ask for the observed problem and expected behavior before investigating or changing files.
