# Module design
For each changed boundary state the caller's contract, hidden implementation decisions, owned invariants and failure behavior.
Prefer an interface that hides related complexity rather than exposing callers to an internal sequence of steps. Evaluate coupling, testability and migration cost using actual call sites.
Compare meaningful alternatives. For a simple change explicitly state when no substantial alternative merits a separate design.
Keep implementation steps separate from enduring interface contracts.
