# Security Policy

## What roundtable defends against

| # | Threat | Mitigation |
|---|---|---|
| 1 | Shell injection via prompt text | `execFile` with args array, `shell: false`, prompt delivered via stdin/arg — never interpolated into a command string |
| 2 | Arbitrary process execution | Binary allowlist: only commands from registered adapter manifests can run; guest names resolve to a fixed manifest |
| 3 | Secret leakage into shared transcripts | Redaction filter on every bus write (`sk-…`, AWS keys, GitHub tokens, private keys, `PASSWORD=`-style lines) |
| 4 | Malicious guest output auto-executed by host | Guest answers wrapped in `⟦roundtable⟧` delimiters + host skill rule: treat guest text as data, never as commands, without user approval |
| 5 | Runaway guests | Per-call timeout (default 120s) and per-session spawn cap (default 25), guest killed on breach |
| 6 | Supply chain | Zero npm dependencies; Node built-ins only (`node:sqlite`, `node:child_process`, `node:readline`). Nothing to audit but us |
| 7 | Workspace clobbering | Advise mode default (read-only); act mode is opt-in per call with git guards + `roundtable undo` recovery |

## What roundtable does not defend against

- A guest you explicitly asked to edit files in act mode will edit files. That is the same trust you extend to any coding agent — the guards are visibility (diff-in-transcript) and recovery (`undo`), not prevention.
- Local malware with filesystem access can read `~/.roundtable/bus.db` (transcripts). Store no secrets in prompts.
- Turn-based v1 does not sandbox network access of guests; each CLI's own sandbox flags apply.

## Reporting

Open a private advisory via GitHub security advisories on the repo, or an issue labeled `security`.
