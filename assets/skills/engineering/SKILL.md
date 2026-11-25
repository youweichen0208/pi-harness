---
name: engineering
description: Use when the user requests changes to a software project, including small fixes, UI tweaks, features, and refactoring. Select the lightest workflow appropriate to the actual risk.
---

# Engineering

Deliver working software with the lightest workflow that fits the risk. Write in the user's language.

## Route

- **Quick Fix**: a local, reversible change with clear behavior. Use Understand → Build → Verify → Evolve. Keep the work in the conversation and existing tests: no change document, no `grilling` without material ambiguity, `tdd` only when a useful automated seam exists, and Evolve only when the change produced durable knowledge worth recording.
- **Feature**: new behavior, an API, or a meaningful interface decision. Use Design → Build → Verify → Evolve and one change document.
- **Complex Change**: core architecture, cross-module behavior, persistence, compatibility, or high risk. Add the relevant specialist skills below.

Upgrade the route when investigation exposes materially greater risk or uncertainty.

Load a selected skill with the native read tool from its entry in `<available_skills>`. The location identifies the actual source. A user or project skill with the same name overrides the bundled copy. Respect that ownership, but do not assume the override satisfies this workflow. Surface a conflict if it requires unauthorized actions or cannot produce the stage's required evidence.

## Design

Read the relevant AGENTS.md, project map, glossary, ADRs, and code. Investigate facts before asking questions.

- For material requirement or domain ambiguity, read `grilling`; when terms or decisions need to change, also read `domain-modeling`. When the request is already clear, design directly without an interview.
- For interface or test-seam choices, read `codebase-design`.
- For complex architecture, read `architect`.
- Identify affected public interfaces, core modules, persistence, compatibility, and platform behavior before implementation.

For Feature and Complex work, maintain one change document using [the template](templates/change.md). Use an explicitly supplied location first, then the project's documented convention, then `docs/changes/<feature>.md`. Do not create a second progress tracker.

Design is complete when scope, non-goals, acceptance behavior, test seams, and impact are concrete. Present that saved version and obtain confirmation before Build unless the user already approved this exact design. After explicit confirmation, immediately record the approved design revision, Goal/Design/Acceptance content fingerprint, and actual user evidence in the same change document. A slash command alone is not implementation authorization. Confirmation is a workflow agreement, not a tool-enforced lock.

## Build

For testable behavior, read `tdd` and deliver one vertical slice at a time. Bug fixes begin with a reproduction. Pure styling, copy, or behavior without a useful automated seam can use targeted runtime verification instead.

Use the current session, model, and native tools. Reuse evidence from a selected skill instead of repeating its work. Return to Design if scope or contracts materially change.

Build is complete when each agreed behavior has implementation and appropriate red/green or runtime evidence.

## Verify

Run relevant tests and exercise the real artifact. Review the actual diff against the requested behavior and project standards. For high-risk changes, read `blast-radius` and verify the safety facts identified during Design.

Verification is complete when important findings are resolved and every check is recorded as passed, failed, or unrun. Compilation alone is not runtime evidence.

## Evolve

For Feature and Complex work, read `knowledge-sync` and check the project's existing authoritative documentation. For Quick Fix, skip Evolve unless the change produced a durable fact worth recording; when it did, read `knowledge-sync` for that fact only. Archive the change document only when the project has an archive convention and every required acceptance criterion is satisfied.

Use `/skill:learn` or `/skill:reflect` only when the user explicitly requests knowledge distillation or durable lessons; neither is a delivery step.

## Resume and finish

To resume, read [the resume approval guide](references/resume.md), then inspect the existing change document, actual diff, and current test results. Reconcile completed work before continuing. A matching approved revision with unchanged design, acceptance, and actual scope continues directly; missing or stale approval gets one confirmation request.

Finish with the delivered behavior, verification evidence, documentation disposition, and remaining risk. Do not claim completion while required behavior or verification remains unresolved.
