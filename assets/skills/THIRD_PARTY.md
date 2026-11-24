# Bundled Skill licenses

Third-party Skills are vendored snapshots. Update them by selecting a new upstream version, reviewing the complete skill and its references, recording the new pin and adaptations here, and running the Engineering Skills regression and representative-task validation.

## pi-harness Skills

When copying one of these Skills, include the project license as `LICENSE` in the copied directory. Preserve any additional notice at its original location within the Skill.

| Bundled Skill | Project license | Additional notice |
| --- | --- | --- |
| `engineering/` | [pi-harness MIT](LICENSES/pi-harness-MIT.txt) | [Marked license](engineering/scripts/vendor/marked-LICENSE.txt) |
| `knowledge-sync/` | [pi-harness MIT](LICENSES/pi-harness-MIT.txt) | — |

## Engineering approval helper

The helper ships [Marked 16.4.2](https://github.com/markedjs/marked/tree/v16.4.2) beside the script so a copied Skill can parse Markdown in a project without installed packages. `engineering/scripts/vendor/marked.mjs` is the unmodified npm distribution file `lib/marked.esm.js` with an ESM extension. Its original `LICENSE.md` is included as `engineering/scripts/vendor/marked-LICENSE.txt`. Copy and update both files together.

## Matt Pocock Skills

- Repository: https://github.com/mattpocock/skills
- Release: `v1.3.2`
- Commit: `d1478fcb140db0b93c0c8df17bcfd311844749d0`
- License: MIT; see `LICENSES/mattpocock-skills-MIT.txt`.

| Bundled path | Upstream path | Pi / V2 adaptations |
| --- | --- | --- |
| `grilling/SKILL.md` | `skills/productivity/grilling/SKILL.md` | Scope interviews to material engineering decisions; use native read-only tools instead of subagents; format choices for the existing WebUI question cards. |
| `domain-modeling/` | `skills/engineering/domain-modeling/` | No substantive change; retain the glossary and ADR format references. |
| `codebase-design/` | `skills/engineering/codebase-design/` | Preserve the complete fixed upstream vocabulary and DEEPENING reference, including internal and external seams; replace only the optional parallel DESIGN-IT-TWICE branch with current-session comparison. |
| `tdd/` | `skills/engineering/tdd/` | Resolve codebase-design by name from the current session's available Skills rather than a cross-directory path; merge seam approval into the approved design and use existing public seams for quick fixes; return review to Engineering instead of the unbundled code-review Skill. |

`grill-with-docs` is not vendored. At this pin it is a user-invoked wrapper that invokes `grilling` and `domain-modeling`; Engineering performs that routing directly. `implement` and `code-review` are not vendored because their automatic commit, user-invocation, or parallel-subagent orchestration conflicts with the M1 boundary.

## Poteto pstack

- Repository: https://github.com/cursor/plugins
- Upstream directory: `pstack/`
- Commit: `005d8f6e8ec057b738adcd08a08b30db0478402d` (no independent pstack Release used)
- License: MIT; see `LICENSES/pstack-MIT.txt`.

| Bundled path | Upstream path | Pi / V2 adaptations |
| --- | --- | --- |
| `architect/SKILL.md` | `pstack/skills/architect/SKILL.md` | Enable model-selected use; keep large or contested design comparison in the current session instead of automatically invoking Arena. |
| `blast-radius/SKILL.md` | `pstack/skills/blast-radius/SKILL.md` | Enable model-selected use; partition wide changes in the current session instead of invoking Arena; remove the final Unslop dependency while retaining evidence and plain-writing requirements. |
| `reflect/SKILL.md` | `pstack/skills/reflect/SKILL.md` | Keep explicit user invocation and edit approval; acknowledge partial transcript access; copy approved changes to Pi personal or trusted project Skill directories instead of Cursor paths; distinguish directory Skills from standalone files, approve the exact copy list, and include the corresponding third-party copyright and license notice; preserve bundled originals. |

Arena, Swarm, Correct, How, Why, and Unslop are not vendored in M1. No upstream Skill is edited in a user's personal installation.
