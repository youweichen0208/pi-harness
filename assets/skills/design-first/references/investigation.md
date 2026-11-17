# Investigate related code
Start from the requested behavior's entry point, related tests and project architecture docs. Expand only along relevant callers, state owners and failure paths. Record the inspected scope and gaps.
Use symbol/content search to locate relevant ranges, then read those ranges. List directories when the location is unknown; do not repeatedly list known directories or reread whole large files instead of following a concrete question.
After tracing the first meaningful path, save the findings and a provisional recommendation in the existing draft. Update it as evidence changes. Read another module only when its answer could change the proposal, resolve a stated unknown or verify a citation. When the available budget is limited, save verified findings and explicit gaps before writing a long explanation.
For each important claim record path, symbol, line range, version/observed content fingerprint and inspection time. Read the cited lines back before delivery. Uncommitted content has no commit identity; label it as working-tree evidence.
Use verified_code, verified_test, confirmed_history, inference or unknown. A document describes intent, not proof of current implementation. A matching name is not proof of a dynamic call path.
Reading a test definition is verified_code about intended coverage, not verified_test. Reserve verified_test for an actual execution record, and state which inputs that run covers.
Stop investigation when the proposal's key dependencies and risks are explained or explicitly blocked, not when every repository file has been read.
