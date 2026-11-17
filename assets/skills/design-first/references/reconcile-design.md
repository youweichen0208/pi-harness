# Reconcile intent and implementation
At task boundaries, resume and completion, compare actual changed contracts with the reviewed design and acceptance criteria.
Update factual progress when documents lag code. Keep code evidence separate from inferred compliance.
For a material API, data model, safety or requirement change, preserve the original design and create a proposal using [design-change-proposal](../templates/design-change-proposal.md); explain impact and request review before dependent implementation.
Expected implementation edits do not invalidate the design by themselves. Unknown or external modifications require investigation, not automatic attribution to this task.

## Reconcile the project spec

Find the authoritative description of the affected behavior from project instructions and relevant existing documents. It may be an OpenSpec capability spec, a docs/specs file or an architecture document. Follow the local proposal/delta/archive convention when present; an OpenSpec directory alone is not permission to install a CLI or rewrite all specs. Keep one authoritative description instead of creating parallel copies.

For an existing OpenSpec change, map every design requirement ID to the project's capability delta and use its configured schema. With the default Markdown schema, express observable behavior as:
```markdown
### Requirement: <stable requirement name>
#### Scenario: <observable condition>
- **WHEN** <trigger>
- **THEN** <observable result>
```
Run the project's documented validation command, or the appropriate local OpenSpec validation when the CLI is already available, and record the actual command and exit code. Do not install OpenSpec or change its configuration as a side effect. If required validation cannot run, mark it not_run and leave the corresponding validation or synchronization step pending.

Before implementation, record the spec path/section and proposed delta (or why the contract remains unchanged) alongside the design. Keep proposed behavior visibly distinct from the current contract. Respect project rules for when accepted deltas become canonical; do not mark implementation or verification complete before evidence exists.

After implementation and relevant checks, compare the approved intent, actual behavior, tests and spec:
- **updated**: behavior was added or an incomplete spec needed clarification; apply the reviewed delta and link the affected section to the change record according to project conventions.
- **unchanged**: the fix restores behavior already specified accurately; retain the contract text and record the spec reference, reason, root cause and regression evidence in the change/outcome record.
- **pending**: behavior or acceptance remains unresolved, checks are insufficient, or the project's merge/archive condition has not been met; preserve the proposal and state what remains before synchronization can finish.

When no relevant spec exists, use the project's established documentation location. If there is no convention, keep the requirement IDs and equivalent observable scenarios in the change design and explicitly record that no canonical spec exists; propose a durable location when warranted. A guessed path or an unexecuted future action is not a synchronized spec.

Preserve unrelated content and user edits. Reread the affected section before editing, inspect the final diff against the implementation and record the disposition with concrete links. If a conflict or material discrepancy needs a decision, leave it pending rather than rewriting the spec to justify accidental behavior. Final delivery names what changed in the spec, why it stayed unchanged, or what still needs synchronization. Report the canonical merge/archive next step; archive only after an explicit archive request and under the project's convention, never merely because implementation completed.
