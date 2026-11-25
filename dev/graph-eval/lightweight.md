# TypeScript listener-array candidate

The pinned eight-file corpus yields one structural route for `agent_settled` to `conv.lastTaskEndedAt`. The SDK calls its own emitter at line 1150, forwards the exact event into its listener array at 1106, and registers listeners on the same field at 1458. The host's Conversation declares the SDK session at line 47. Its subscription at 935 forwards the same callback parameter at 938 into the handler with the matching case at 1088 and direct assignment at 1092. The adjacent extension-runner emission at 1149 produces no path to this write.

Run from the project root after preparing the pinned corpus:

```sh
node dev/graph-eval/lightweight.mjs .scratch/graph-eval/samples agent_settled conv.lastTaskEndedAt sdk harness
node dev/graph-eval/lightweight-test.mjs
node dev/graph-eval/verify-case.mjs
```

The CLI lists source, path, owner, line range and SHA-256 for each matched role, then reads the original lines again and checks their hashes. Its `candidates` array contains downstream consumer leads regardless of whether a publisher can be connected. Only `paths` includes the typed cross-project connection. The separate synthetic fixture covers 27 observations across three sources, including callback filters and reassignments, conditional emissions, disjoint listener arrays, changed exports, excluded intermediaries, rename, deletion and dependency version mismatch.

On Darwin arm64, Node 26.0.0, TypeScript 5.9.3, five sequential runs in one process on separate copies of the pinned sample yielded the following medians. Each cold run used a new index with no previous ASTs. The OS file cache and JS runtime warmed across runs. The edited run appended a comment to the host's service file.

| Operation | Median time |
| --- | ---: |
| Cold scan, four TypeScript files plus four configuration files | 33.90 ms |
| Validate identical input bytes | 0.65 ms |
| Refresh after one TypeScript file changed | 23.29 ms |
| Query existing paths by tag and sink | 0.006 ms |
| Read back all eight anchors and verify digests | 2.03 ms |

The resolver covers explicit versions, local relative imports, a declaration export and a TypeScript build script mapping its output to sources. The matcher covers direct writes in a tagged switch, an arrow callback that forwards its only payload reference, and an array-based listener registry. A refresh hashes all selected source files, reparses changed TypeScript and reconstructs semantic relations for the selected scope. Full-project latency, other languages and broad recall remain unmeasured. A structural path assumes compatible receiver types and a live subscription; guards, disposal, runtime overrides, side effects and deployment can prevent any particular delivery. Incident verification still requires runtime evidence.
