# Guard Schema Compatibility

Status: T31 contract. Current persisted guard shape is schema v1.

## Version model

- A guard without `schemaVersion` is v1. Existing v1 files remain valid.
- New v1 writers may emit `schemaVersion: 1`, but readers must accept both the
  explicit and legacy implicit form.
- A v2 writer emits `schemaVersion: 2`.
- Product version and guard schema version are independent. VibeBloat 2.x must
  continue reading v1 guards.
- Unknown major schema versions are rejected before evaluation or installation.

## v1 compatibility promise

VibeBloat 2.x must preserve v1 meaning for:

- `id`, class `A|B|C|D`, provenance, `match.chokepoint`, `command`,
  `argsContains`, `argsAnyOf`, `path`, action, confidence, tier, binds, and
  enabled state;
- Class A fail-closed and Class B/C/D fail-open parse-error policy;
- mandatory normalization before guard evaluation;
- all five trusted action types and one-time override behavior;
- missing optional fields using their v1 defaults. Missing `binds` means all
  installed agents; missing `confidence` or `tier` does not change matching.

V2 must not reinterpret an accepted v1 guard more broadly. A migration may
normalize representation, but must preserve the verdict for the v1 compatibility
corpus.

## Reader and writer rules

1. Parse JSON without mutation.
2. Determine schema version: missing means 1; otherwise require a positive
   integer.
3. Validate against that version's closed schema. Unknown fields are rejected
   unless the version explicitly defines them.
4. Convert into the internal canonical guard model.
5. Evaluate only the canonical model.

V1 files remain v1 on disk during ordinary load. An explicit migration writes a
sibling temporary file, validates and evaluates it against the compatibility
corpus, then atomically renames it. Keep a rollback copy until `vibebloat doctor`
passes.

Community guards declare `schemaVersion`; local legacy guards may omit it. The
library refuses a guard requiring a newer unsupported major version and prints
the standard three-line error with an upgrade command.

## Breaking-change boundary

These require a new schema major version: removing or renaming a field, changing
a default, broadening match semantics, changing parse-error policy, changing
normalization order, or changing an action's allow/block behavior.

Adding an optional field is compatible only when absence preserves existing v1
behavior. Security fixes may narrow unsafe behavior in any release, but must be
documented and covered by a regression fixture.

## Acceptance checks

- Every current built-in, compiled, local, and community v1 fixture loads in the
  v2 reader and produces the same verdict for positive and true-negative events.
- Explicit `schemaVersion: 1` and missing `schemaVersion` produce identical
  canonical guards.
- Unknown version, unknown field, invalid type, and missing required v1 field are
  rejected before runtime evaluation.
- Migration crash leaves either complete old file or complete new file, never a
  partial guard.
- Downgrade after failed doctor restores the exact v1 bytes.
