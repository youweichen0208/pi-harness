# Resume approval

Use this guide for Feature and Complex changes. It is a documentation workflow, not a security boundary or a tool-enforced lock.

## Record the decision

Keep approval in the existing change document:

- `Design revision` identifies the current Goal, Design, and Acceptance Criteria. Start at 1.
- `Approved revision` is the revision explicitly confirmed by the user. Keep it `none` while approval is absent.
- `Approved content SHA-256` is the fingerprint of the approved Goal, Design, and Acceptance Criteria, computed when the user confirms. It is `none` while approval is absent.
- `Evidence` briefly records the actual confirming user message and when it occurred. Write it immediately after that message; never infer or backfill approval.

Use the [approval fingerprint script](../scripts/approval-fingerprint.mjs) from the active Engineering Skill directory. Keep exactly one document-level Goal, Design, Approval, and Acceptance Criteria section. Nested headings belong to their enclosing section. Write each approval field on its own line in a plain paragraph. Examples and HTML comments can preserve history; only visible fields in the current record count. Missing or duplicate fields require confirmation.

```bash
# Set skill_dir to the directory containing the active Engineering SKILL.md
# and change_doc to the path of the existing change document.
if [ -n "$PI_WEB_NODE_RUNTIME" ]; then
  runtime="$PI_WEB_NODE_RUNTIME"
  export ELECTRON_RUN_AS_NODE=1
else
  runtime=node
fi
"$runtime" "$skill_dir/scripts/approval-fingerprint.mjs" fingerprint "$change_doc"
"$runtime" "$skill_dir/scripts/approval-fingerprint.mjs" verify "$change_doc"
```

Desktop exposes `PI_WEB_NODE_RUNTIME` as the absolute path of its bundled Electron executable. CLI and Web normal sessions expose the absolute path of the Node.js executable that started the service. The commands therefore work when `node` is absent from the tool environment's PATH. Keep the runtime absolute and do not download a replacement.

At approval, write the `fingerprint` output into the document. At resume, run `verify`: `APPROVED` means the recorded content still matches; `STALE` and `NEEDS_CONFIRMATION` require the confirmation branch. A missing fingerprint or unreadable approved sections can never be treated as unchanged.

When scope, contracts, or acceptance behavior materially changes, increment `Design revision`, reset approval to pending, and set both `Approved revision` and `Approved content SHA-256` to `none`. Top-level Acceptance Criteria checkbox state, Implementation checkboxes, and Delivery evidence can change without affecting the design revision or content fingerprint; acceptance wording, indented examples, and literal checkbox text remain protected.

The fingerprint includes the destination and title of each reference-style link or image used in Goal, Design, or Acceptance Criteria, wherever its definition appears. An unresolved reference in these sections might have lost its definition. When an older fingerprint covered only the raw text and the contract contains reference-style syntax, confirm the current design once before recording its new fingerprint.

## Decide how to resume

Inspect the document, actual diff, and current test evidence before choosing a branch.

| Evidence | Required action |
| --- | --- |
| Approved revision matches Design revision; Goal, Design, Acceptance Criteria, and actual scope are unchanged | State the matching approval evidence and continue the next unfinished stage without another approval request. |
| Approved revision matches, but Acceptance Criteria or contracts have changed, even if the revision field was not updated | Treat the approval as stale. Update the revision and approval fields, present the changed behavior, and request one confirmation before Build. |
| Approval is absent, evidence is unclear, revisions differ, or the actual diff exceeds the approved scope | Present the current affected design and request one confirmation before Build. |
| Work and all required acceptance checks are already complete | Report current facts read-only. Do not replay implementation or describe historical tests as newly run. |

A matching `Approved revision` field alone is never enough: the design and acceptance content must also be unchanged. Do not request confirmation for every file or completed vertical slice. Resume from actual unfinished behavior rather than restarting stages that already have valid evidence.
