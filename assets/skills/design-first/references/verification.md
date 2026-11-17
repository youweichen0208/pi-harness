# Verification evidence

## Implementation feedback loop
Map every requirement ID to its scenarios, implementation and meaningful verification. Discover the project's checks from its instructions/configuration and use the public behavior seams confirmed in the design.
When a cheap, deterministic behavior test can reach the seam, work one vertical slice at a time: write one test, run it and observe the expected failure, implement the minimum, then rerun it and observe success (red → minimal green). Use the bug's reproduction as the failing test when practical. Do not batch all tests before implementation or claim red without executing it.
When no suitable test seam exists, record why and verify the original behavior through the real HTTP/CLI/browser or other observable deliverable. Static inspection and a checked task box are not substitutes for execution.

## Evidence
Record command, execution time, actual environment versions, HEAD if any, relevant working-tree inputs, exit code and result.
Preserve the test process's exit status. Prefer running the test command directly; when output is piped or followed by another command, capture the original status explicitly. A successful tail, formatter or final shell command is not proof that the tests passed. If the original exit status was lost, rerun or record it as unknown.
Test source describes an assertion someone wrote; label it verified_code and not_run until execution evidence exists. Do not redefine verified_test to mean "read the tests".
Use todo, in_progress, implemented_unverified, verified or blocked for task progress. Record not_run when a check was not executed; distinguish failed, cancelled, timed_out and environment_unavailable.
A prior passed result is historical. Changed inputs or uncertainty about their identity mean current work is implemented_unverified until rechecked. Equal HEAD and dirty status are insufficient, and equal before/after fingerprints cannot exclude transient concurrent modifications.
M1 does not promise immutable source reconstruction or process isolation. Avoid copying credentials, secret environment values or customer data into evidence.

## Code quality review
Before completion, inspect the actual changed files and diff against project instructions and coding standards. Check behavior-level tests, regression risk, error paths and unnecessary complexity separately from spec compliance. Record concrete findings and their resolution, or the reviewed diff identity and any limits when no findings remain.

## Design and spec review
Separately account for every requirement ID: compare the approved scenarios, actual implementation, executed evidence and spec disposition. Investigate deviations rather than editing the design to match accidental behavior. Record missing coverage, pending decisions and archive/publication steps. Completion requires both reviews, acceptance coverage and actual verification evidence; unchecked work remains implemented_unverified or pending.
