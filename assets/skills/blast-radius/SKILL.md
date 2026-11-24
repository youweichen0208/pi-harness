---
name: blast-radius
description: Find what a change could break beyond its diff and prove the key safety fact by running real code. Use for public interfaces, core modules, persistence, cross-platform behavior, or a small diff with uncertain impact.
---

# Blast radius

Find what a change breaks somewhere else before it ships. Listing callers is only the starting point; the job is the breakage a symbol search will not show.

## Evidence levels

For each fact the change's safety depends on, reach the cheapest strong evidence and state where it stopped:

1. An unsupported assertion.
2. A cited `file:line` or the library's source.
3. A failure-path walkthrough showing the bad case cannot reach the outcome.
4. A script or test that calls the real code and fails loudly if the fact is false.
5. A reproduction in the running application.

An assertion alone is not proof. Step 4 is usually one small script that imports the same code the application ships.

## Process

1. Read the change, its added, modified, and deleted symbols, and the behavior the diff does not make obvious. Use the impact list prepared during design.
2. Find the one or two facts on which safety depends. Concentrate investigation there.
3. Look where search stops: the pinned dependency's implementation, wire formats, persisted bytes, timing and teardown, another language or runtime, feature flags, and downstream behavior.
4. Give each retained risk a realistic likelihood and cost. Keep cleared concerns separate and cite real evidence.
5. Prove the key fact with a real script, test, or running application. Mark it unproven if that was impossible.
6. For a wide change, partition the work by subsystem or contract and apply the same proof process to each key fact in the current session.

## Result

- **What changes**: include behavior that is not obvious from the diff.
- **Safety facts**: evidence level and actual proof, or an explicit unproven status.
- **Risks**: failure mode, `file:line`, likelihood, cost, and the cheapest check.
- **Cleared**: what was checked and the evidence that clears it.
- **Before delivery**: the cheapest regression test or reproduction that catches the real failure.

Write plainly, cite real code, and omit private information. The result must distinguish verified facts from inference.
