# Workspace graph evaluation

The pinned corpus contains eight files from pi-harness v2.1.0 and Pi v1.6.0. Both repositories are public. Each file has a commit and SHA-256 in [the manifest](corpus.json). Preparation can use a local SDK checkout containing the pinned commit via `--sdk-repo`. The default fetches only the SDK files from GitHub and reads the harness files from Git. Repeated preparation checks the existing corpus.

```sh
node dev/graph-eval/prepare.mjs
node dev/graph-eval/lightweight.mjs .scratch/graph-eval/samples agent_settled conv.lastTaskEndedAt sdk harness
node dev/graph-eval/lightweight-test.mjs
node dev/graph-eval/verify-case.mjs
node dev/graph-eval/compare.mjs
```

The question starts at the host's last-task timestamp. The gold route goes through SDK lines 1150, 1106 and 1458, the host's session type in conversation.ts at 47, then agent-service.ts at 935, 938, 1088 and 1092. SDK line 1149 dispatches the same event through an independent channel. The oracle checks exact provenance, mutations and removal. The separate three-source fixture removes an intermediary package and checks that the transitive route disappears.

| Candidate | Native observation for the target |
| --- | --- |
| [Graphify](graphify.md) | Locates both local calls and identifies a different receiver at line 1149. Its merged cross-project edges do not connect this subscription. |
| [GitNexus](gitnexus.md) | Locates the SDK emitter call, host callback and property access. The native group produced no contracts or cross-links for the target. |
| [TypeScript](lightweight.md) | Resolves the producer's listener array to the typed subscription and branch-specific assignment. The proof includes the two projects and eight line-anchored observations. |

The comparative script consumes the external engines’ recorded owner exports and runs the same TypeScript proof against the pinned source. Each engine supplies all five nominated methods on this known-answer problem. With source verification, each can support the same route. This measures corroboration of a known chain. General discovery, language coverage and timing budgets for other tasks require further samples. Each candidate report gives its actual version, native observations, reproduction commands and timing methodology. Select the lightweight approach for the first supported event family to keep one local production dependency and one source verification rule.

The product worker also processed the two complete fixed source archives. On the local arm64 Mac it indexed 4,419 supported files and 14,297 within-repository import edges. With cross-package binding resolution enabled, it produced 78 additional package import edges and took about 4.2 seconds. A separate fingerprint scan took about 0.4 seconds. These measurements are one local run. [The Ask experiment](ask-results.md) records the separate model, citation and token comparison.
