---
name: design-first
description: Prepare a design proposal for a cross-module change or significant trade-off, or resume a saved design from its documents and current source. After confirmation, implement, verify and reconcile project specs.
---

# Design First

Help the developer understand the current system, choose a design, and recover real progress without relying on chat history. Write in the user's language.

This packaged skill currently implements the M1 document workflow. It cannot enforce permissions or restore trusted approval. Reading this skill does not convert an ordinary session into a Managed Session. Respect existing user authorization and the host's actual capabilities; never manufacture approval records or claim a tool guard is installed.

Use the current Pi session, selected model and its existing read/edit/write/bash tools throughout this workflow. No separate model, ChangeStore, managed execution service or OpenSpec CLI installation is required. The confirmation below is a conversational workflow agreement, not a technical tool lock.

## Start or resume

Use [resume-work](references/resume-work.md) when the user identifies an existing change or you locate its saved documents. A feature name alone does not make this a resume. For a new requirement, check the project's document conventions and the first relevant entry point, then choose:
- Quick: a local, reversible change. Keep one short design with problem, location, proposed change, acceptance and progress. Do not generate empty architecture chapters or ADRs.
- Standard (default): a feature with meaningful interface or behavior decisions. Create design.md and minimal progress.md in the selected change directory immediately; save tasks.md before requesting design confirmation.
- Deep: cross-module or consequential architectural work. Include failure paths, compatibility, alternatives and verification strategy.

Use a stable, unique change ID. Creation and recovery use the same location priority: an explicitly supplied change location, then the project's documented convention (such as openspec/changes/<change-id>/), then docs/changes/<change-id>/ as the fallback. Read project instructions before creating files and preserve existing artifacts. Templates live in [design](templates/design.md), [progress](templates/progress.md) and [tasks](templates/tasks.md). Replace instructional text with evidence; omit inapplicable sections.

For a small feature or bug fix, read [small changes](references/small-changes.md) and use Quick when the inspected impact is local. The route determines what to investigate and confirm; it does not require a separate skill or model. Follow the project's existing spec location and change conventions.

Save the first checkpoint before expanding into more callers or modules: the actual requirement, inspected entry point, unresolved questions and next step. Mark it investigating, not approved or complete. Quick work can keep this in its single design file; Standard/Deep work uses progress.md and a short design draft. Do not wait until investigation or a long final explanation is finished to write these files. If saving is unavailable, report that limitation.

Make that checkpoint a separate, small save. It is expected to be incomplete: record the requested behavior and one observed entry point, leaving the recommendation unknown until investigated. Do not compose the complete final design in thought before the first write. State the chosen change location in the handoff. Read references selectively after saving; they are not a checklist to load before work can begin.

## Understand and decide

Investigate incrementally using [investigation](references/investigation.md). Trace [How](references/how.md) before explaining [Why](references/why.md). Consult [domain-modeling](references/domain-modeling.md) for new domain terms or conflicts, and [codebase-design](references/codebase-design.md) for module/interface choices. Ask only consequential questions that available code cannot answer, using [focused-grilling](references/focused-grilling.md).

Present the recommendation, relevant alternatives, consequences and unresolved decisions. Identify which facts are verified and which remain unknown. A blocked decision is a concrete reason to stop that dependent work, while independent investigation can continue.

Show the exact design version the user is deciding on. Preserve important revisions through an existing commit or a design-revisions file; do not automatically commit the user's worktree. A slash command selects a workflow; it is not implementation authorization by itself. Before implementation, obtain clear authorization in this session for the exact saved design and spec proposal presented to the user. Existing authorization applies only when it identifies that proposal. A stored “approved” note is not authorization in a new session.

Before asking for confirmation, save the concrete proposed fix/design, spec impact, acceptance criteria and task list to the change document, then reread it to ensure it matches the proposal in your reply. An investigating checkpoint alone is not the review handoff: the next session must be able to recover the proposal without chat history. Link that saved version, summarize the choice that needs confirmation, save the next action in progress, and wait when authorization is missing. Keep the actual requirement in design.md rather than creating another duplicate requirements document. Quick changes may keep their task list inline in that file.

## Implement and reconcile

After confirmation and before editing business code, read [verification](references/verification.md) and use its feedback loop. Implement the task list with the session's native editing tools; do not stop at offering to implement or invent a new execution engine. Maintain task status and factual progress at task boundaries. Read [reconcile-design](references/reconcile-design.md) when scope changes, when resuming, and before completion; reconcile the corresponding project spec as part of delivery. Material contract changes require renewed human review; ordinary expected implementation edits do not require approval after every file.

Execute relevant checks using the available native command tool. Record the actual command, execution time, exit code, environment and tested input identity (relevant file versions or fingerprints), using [outcome](templates/outcome.md); include failures or inability to run. Before completion, perform verification's code-quality and design/spec reviews separately. Quick work can keep outcome, tasks and progress as sections in its single change file; Standard/Deep uses outcome.md, tasks.md and progress.md. Update evidence links, remaining work and the next resume action before the final reply. Tests that fail or have not run cannot become verified by prose. Domain/ADR proposals remain proposals until reviewed and merged under project conventions; use [ADR](templates/adr.md) only for durable architectural decisions.

When asked to explain a decision or code, use [teach](references/teach.md). Do not automatically repeat the complete design or run a model in the background.
