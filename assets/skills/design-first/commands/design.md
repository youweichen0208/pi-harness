---
description: Design or resume a change, confirm the proposal, implement and verify it, and reconcile specs
argument-hint: <requirement or resume change-id>
---

Use the full Start or resume workflow of the bundled Design First skill. Read its instructions at this JSON-encoded path: {{DESIGN_FIRST_SKILL_PATH}}. The user has explicitly selected design-first work; use the current session and model. For a new requirement, investigate and choose Quick/Standard/Deep from the observed impact, then save the design, spec impact and tasks before requesting confirmation. For a request to 恢复 <change-id>, follow the Skill's document and current-source recovery rules. This command selects the route and does not authorize implementation by itself; after the saved proposal is presented, use only current-session authorization for that exact design and spec impact. Implement with native tools after confirmation, then verify, perform both reviews and reconcile the spec.

User's request:
$ARGUMENTS

If the request is empty, ask what the user wants to design or resume before investigating or changing files.
