# Small features and bug fixes

Use the shared confirmation, native-tool implementation and verification workflow. Keep Quick work in one change document with a short task list and evidence; split into the standard templates only when useful. A short user description does not prove the impact is small: widen to Standard/Deep when investigation reveals cross-module contracts, data migration or consequential compatibility changes. Record upgrades and downgrades in that document with the previous/next level, reason, evidence and time; a route change must not bypass review.

## Small feature

Locate the affected behavior, its current spec and the nearest implementation/tests. Record the requested behavior, what stays unchanged, observable acceptance criteria, and the smallest proposed change. Include the proposed spec delta in the design the user confirms. After confirmation, implement, run relevant checks, then reconcile the spec using [reconcile-design](reconcile-design.md).

## Bug fix

Record the trigger or reproduction steps, expected behavior and its source (spec, test or user confirmation), observed behavior, and actual reproduction result. Separate a demonstrated cause from a hypothesis. A failed environment setup is not a reproduced bug.

Before changing code, present the supported diagnosis, proposed fix, regression check and spec impact for confirmation, using existing authorization when it covers that concrete fix. Reproduce with a targeted failing test when practical; otherwise record the manual evidence or reproduction limitation and how the fix will be checked. An unreproduced bug remains uncertain even when existing tests pass.

After confirmation, fix the cause and run the regression check plus relevant existing tests. Record actual before/after evidence. If the requested fix changes an existing behavior contract, present that change explicitly instead of treating it as an already-approved correction. A fix that restores an accurate spec normally needs only a linked change/result record.

## Handoff

Include the affected spec path/section, or explain that none exists. Save the next action and missing evidence. At completion record implementation, test results, and the spec disposition defined in [reconcile-design](reconcile-design.md). Quick work can keep all of this inline; file count is not a completion criterion.
