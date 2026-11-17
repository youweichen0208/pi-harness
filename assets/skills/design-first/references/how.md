# How
Trace input → entry → orchestration → state/data changes → output, including error and cancellation paths affected by this requirement. Identify the owner of each invariant and observable contract.
Separate current behavior from proposed behavior. Draw diagrams only when they clarify relationships; a short code path may be clearer as prose.
Mark dynamic dispatch, external services and uninspected branches as uncertain. For a greenfield feature state that no current implementation exists.
