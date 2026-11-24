---
name: knowledge-sync
description: Check actual code changes against a project's existing documentation and make minimal evidence-based updates. Use after implementation, before delivery, or when reconciling docs with a diff.
---

# Knowledge Sync

Keep living project documentation aligned with the delivered system. Checking is required; editing is conditional.

## Inputs

- The request and approved design, when one exists.
- The actual task-scoped diff, including relevant uncommitted changes.
- Test and runtime evidence, including failed and unrun checks.

Separate unrelated user changes from this task. Do not include them in documentation conclusions.

## Check

1. Identify changed domain concepts, module boundaries, architecture contracts, user-visible behavior, and engineering rules.
2. Locate the project's existing authoritative documents through AGENTS.md and other documentation pointers. Respect its current names and structure.
3. Compare each affected fact with the implementation and approved acceptance criteria.
4. Make the smallest update at the authoritative location. Link to it instead of copying the same fact into another document.
5. Leave documents unchanged when the facts still describe the system accurately.

Only create a missing document when it has clear long-term value and fits the project's conventions. A glossary is not an implementation log; a project map is not a design spec; an ADR records a durable decision rather than ordinary task progress.

## Reconcile

If implementation materially differs from the approved design, stop that documentation update and report the difference. Documentation must not conceal missing behavior or turn an unapproved contract into an approved one.

Record validation exactly as observed. Failed, blocked, and unrun checks cannot support a completed acceptance criterion. Do not archive a change as complete while a necessary criterion remains unsatisfied.

## Delivery

Report only relevant dispositions in the delivery summary:

- **Updated**: path, changed fact, and supporting implementation or verification evidence.
- **Unchanged**: affected documents checked and why their facts remain accurate.
- **Blocked**: the unresolved implementation, approval, or verification gap.

Do not create a separate knowledge-sync report for an ordinary task.
