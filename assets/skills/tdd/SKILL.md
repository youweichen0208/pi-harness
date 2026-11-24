---
name: tdd
description: Test-driven development. Use for testable features and bug fixes, red-green-refactor work, and integration tests at public behavioral seams.
---

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle: consult them before and during the loop, not after.

When exploring the codebase, read `GLOSSARY.md` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification: "user can checkout with valid cart" tells you exactly what capability exists and it survives refactoring because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams: where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

For Feature and Complex work, record the seams in the design and confirm them with that design's single approval. Give each proposed seam a one-line note on what it catches and what it misses. For a Quick Fix, use an existing public seam that reaches the reported behavior without another approval round. Ask separately only when choosing the seam itself changes a public contract or creates a consequential new interface.

When the shape of that interface is in question, find `codebase-design` by name in the current session's `<available_skills>` and read its actual `<location>` with the native read tool. Use the selected copy's shared module, interface, depth, seam, adapter, leverage, and locality vocabulary; never derive its path from this Skill's directory.

## Anti-patterns

- **Implementation-coupled**: mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed. → refactor toward the seam, not the internals.
- **Tautological**: the assertion recomputes the expected value the way the code does (`expect(add(2, 3)).toBe(2 + 3)`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth: a known-good literal, a worked example, the spec.
- **Horizontal slicing**: writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead: one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the engineering review stage, not the red → green implementation cycle.
