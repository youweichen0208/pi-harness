# Design

## Problem and acceptance
Record the Quick/Standard/Deep level and its evidence. Assign stable requirement IDs (R1, R2…) and keep them across revisions. Use one row per observable scenario; Quick may need only one.

| Requirement ID | Requested behavior | Scenario (Given/When/Then) | Public seam / acceptance evidence |
| --- | --- | --- | --- |

For a bug, distinguish expected/actual behavior, reproduction evidence and supported diagnosis. For a small feature, identify the added behavior and compatibility boundary.

## Spec impact
Link each requirement to the existing authoritative spec/section and proposed delta, or record why it stays unchanged. Record when no canonical spec exists; keep proposed behavior distinct from current behavior.

## Current system
Record inspected entry points, contracts, state ownership and evidence; distinguish unknowns.

## Domain model
Link the established glossary terms and ADRs used by this change. Identify genuine new concepts or semantic conflicts and their proposals; state when no domain change is needed.

## Proposed design
Explain the recommendation, affected interfaces/invariants, meaningful alternatives and tradeoffs.

## Failure and compatibility
Describe affected failure paths, migration and recovery where applicable.

## Implementation and verification
Map requirement IDs to task IDs and actual checks; list unresolved decisions and artifact links.
