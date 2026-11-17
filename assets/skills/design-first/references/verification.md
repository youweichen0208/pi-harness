# Verification evidence
Map each acceptance criterion to implementation and meaningful verification. Record command, execution time, actual environment versions, HEAD if any, relevant working-tree inputs, exit code and result.
Preserve the test process's exit status. Prefer running the test command directly; when output is piped or followed by another command, capture the original status explicitly. A successful tail, formatter or final shell command is not proof that the tests passed. If the original exit status was lost, rerun or record it as unknown.
Test source describes an assertion someone wrote; label it verified_code and not_run until execution evidence exists. Do not redefine verified_test to mean "read the tests".
Use todo, in_progress, implemented_unverified, verified or blocked for task progress. Record not_run when a check was not executed; distinguish failed, cancelled, timed_out and environment_unavailable.
A prior passed result is historical. Changed inputs or uncertainty about their identity mean current work is implemented_unverified until rechecked. Equal HEAD and dirty status are insufficient, and equal before/after fingerprints cannot exclude transient concurrent modifications.
M1 does not promise immutable source reconstruction or process isolation. Avoid copying credentials, secret environment values or customer data into evidence.
Completion requires acceptance coverage and actual verification evidence; explicitly report any remaining limitation. A checked task box is not evidence.
