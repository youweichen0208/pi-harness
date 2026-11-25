# Ask graph pilot

Six real `/ask` requests traced one known event across the eight public files pinned in `corpus.json`. Each arm had its own Workspace, graph publication, model session, home and service process. The test verified actual Skill expansion and the tools sent to the provider. Model: `deepseek-v4.1-flash`, thinking off. The relay limited each arm to 16 provider requests and 1,800 output tokens per request. The native extension checked the same request and source permissions as the application. No arm delegated to a child.

| Arm | Skill | Graph tools |
| --- | --- | --- |
| A | The locally archived pre-main-agent-first Ask text, frozen in `ask-baseline.md`, SHA-256 `b8eb563c749d248b510c1095dcef9501dd926e191078cf5dd2ca57b61b479088` | None |
| B | Main-agent-first Ask | None |
| C | Same Skill as B, explicitly invoked with `--graph` | Read-only lookup |

Both groups asked about the emitter, registration, dispatch, typed receiver, subscription and assignment for `conv.lastTaskEndedAt`, including the adjacent extension-runner false lead. All six answers identified the SDK session event and distinguished the extension-runner emission. For coverage, the scorer reopened the native citation and required the ID of an actual parent `source_read` result on a pinned file. It counted the predeclared line anchors covered by those reads. A wide read can cover more than one anchor. Coverage measures the provenance of the cited text. It does not score every sentence in the answer.

| Run | Arm | Provider calls | Total seconds | First supporting read (seconds) | First supporting read used in a validated citation (seconds) | Cited anchors out of 8 |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 1 | A | 9 | 20.67 | unmeasured | 7.43 | 7 |
| 1 | B | 12 | 31.93 | unmeasured | none | 0 |
| 1 | C | 6 | 17.03 | unmeasured | 5.34 | 7 |
| 2 | C | 12 | 30.50 | 5.18 | none | 0 |
| 2 | B | 11 | 27.43 | 5.15 | 5.15 | 7 |
| 2 | A | 10 | 22.69 | 6.16 | 6.16 | 6 |

The second run included directional impact instructions in the Skill shared by B and C. The first pair used Skill SHA-256 prefix `e7199ca679`, the second `34a3aed664`. The first run's relay lacked reliable usage coverage. The second captured final provider usage for every call. Measurements for run 2:

| Arm | Input tokens | Output tokens | Distinct files read | Duplicate verified lines / all verified lines | Failed source-tool calls |
| --- | ---: | ---: | ---: | ---: | ---: |
| A | 18,630 | 2,728 | 3 | 0 / 266 | 0 |
| B | 23,738 | 2,649 | 2 | 2 / 337 | 0 |
| C | 30,424 | 3,673 | 4 | 0 / 270 | 4 |

Usage records reported zero cache reads and writes in run 2. The initial B answer cited search-generated IDs after reading files. The second C answer linked raw file paths with line numbers. Neither form met this experiment's strict source-read citation criterion. Both C sessions called graph status and search; neither used the path or neighbors tool. C was faster than B in the first comparison and slower, with more tokens, in the second. Keep graph lookup opt-in. Known error codes, independent hypotheses, missing deployment evidence, model variation, a stable multi-question effect and explicit impact-query benefits remain unmeasured by this pilot.

Reproduce from the project root with the server compiled, the pinned corpus prepared and a matching Anthropic-compatible model configured in a source supported by pi-harness:

```sh
node dev/graph-eval/ask-eval.mjs deepseek-v4.1-flash A B C
node dev/graph-eval/ask-eval.mjs deepseek-v4.1-flash C B A
```

The evaluator prints one JSON record per arm with provider metering, actual tools, source calls, resolved citations, timings and answer. Only the fixed public corpus is copied into the isolated Workspace. Provider credentials stay in memory in the local relay. The baseline was recovered from the local evaluation archive `.scratch/ask-m1/baseline/ask/SKILL.md`; it is an evaluation fixture with no release-version claim. The initial raw reports were written to the ignored `.scratch/graph-eval/ask-pilot*.jsonl` directory entries.
