# Error Pattern Spec

## Contract

Recoverable CLI failures write exactly three newline-terminated lines to stderr:

```text
WHAT failed: <operation that stopped>
WHY: <root cause>
FIX: <one actionable command>
```

- `WHAT failed` describes failed operation, not internal implementation detail.
- `WHY` states root cause in one direct sentence. It must not print raw history,
  secrets, tokens, or stack traces.
- `FIX` contains one copy-pasteable command. Use a placeholder when user input is
  required, for example `vibebloat compile <incident.json>`.
- Do not use emoji, color control codes, headings, bullets, or extra prose in a
  three-line failure.
- Success data stays on stdout. A hook block is an enforcement receipt, not a CLI
  failure template: its exit-2 message remains guard-specific.

## Accepted Examples

Install permission is an exact current compliant example:

```text
WHAT failed: setup permission was not confirmed.
WHY: install changes native agent configuration.
FIX: vibebloat install --yes
```

Missing watch input is another exact compliant example:

```text
WHAT failed: watch directory was not supplied.
WHY: watch needs one directory path.
FIX: vibebloat watch <directory>
```

Malformed `eval` input currently follows the same three-line shape:

```text
WHAT failed: eval input could not be processed.
WHY: <parser or validation root cause>
FIX: provide a guard and event JSON object
```

`FIX` must name one repair path. Do not combine alternatives, chain commands, or
ask user to infer a missing flag. A sentence is acceptable only when the command
cannot be formed without an unavailable value; prefer a parameterized command
over prose when possible.

## Doctor Linkage

`vibebloat doctor` verifies installed guard proofs and native hook configuration.

- Successful native-hook installation tells user to run `vibebloat doctor`.
- A doctor failure aggregates finding messages in `WHY` and points to installation
  repair in `FIX`; it does not hide individual drift causes.
- An install or hook-configuration failure must point to its smallest safe install
  command, normally `vibebloat install --yes`.
- `doctor` is verification after repair, not a substitute for the repair command.

Current CLI behavior has migration gaps from the one-command rule:

- Doctor emits `FIX: vibebloat install`, while `install` requires `--yes`.
- `eval` emits explanatory prose instead of a command.
- Scan and compile catch paths mix repair prose with a command.

Those outputs remain the recorded baseline. Change each implementation and its
exact-output test together when its repair wiring is updated.

## Current Baseline

- `src/cli.ts` emits the pattern for doctor, install, init, allow, disable, watch,
  scan, compile, eval, and unsupported-mode failures.
- `src/hooks/shell-shim-cli.ts` uses the same pattern when its real Git executable
  is missing.
- The `watch` runtime detection message begins `WHAT detected`; it reports a
  post-write observation rather than a failed CLI operation and is outside this
  contract.

## Verification

Keep exact stderr assertions with behavior changes:

- `tests/match.test.ts` checks three-line malformed `eval` output.
- `tests/cli-init.test.ts`, `tests/cli-compile.test.ts`, `tests/cli-scan.test.ts`,
  `tests/cli-watch.test.ts`, and `tests/cli-runner-mode.test.ts` lock exact
  failure text.
- `tests/cli-install.test.ts` and `tests/doctor.test.ts` cover install and doctor
  repair paths.

For a new failure, add one focused test that asserts exit status, stderr contains
only the three contract lines, and `FIX` supplies the intended command.
