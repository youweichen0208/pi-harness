---
name: architect
description: Sketch types, signatures, and module structure before code, then stay in the loop while implementation fills in. Use for complex architecture, cross-boundary changes, or designs where jumping to code would lock in the wrong shape.
---

# Architect

Before writing code, trace every system the change touches, then sketch two different shapes for it (types, signatures, module boundaries) and pick the one where each piece of state has one owner, each task has one way to do it, and callers need to know least. Redesign instead of patching if workarounds repeat.

For a large or contested design, develop both shapes in the current session and present their trade-offs with the recommendation. Resolve the decision through the engineering design approval; keep the work in one session unless the user explicitly requests a separate multi-agent workflow.
