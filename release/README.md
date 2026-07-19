# Controlled release verification

`release/metadata.json` is created only with a controlled release. It must contain:

```json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "artifact": "dist/vibebloat",
  "bundle": "release/vibebloat.bundle",
  "publicKey": "release/vibebloat.pub",
  "publicKeySha256": "lowercase SHA-256 of exact public-key bytes",
  "communityGuardManifest": "release/community-guards.json",
  "communityGuardManifestBundle": "release/community-guards.json.bundle"
}
```

Workflow dispatch validates closed metadata, hashes exact public-key bytes, then
runs `cosign verify-blob` for both binary and closed community-guard manifest.
No key, signature, manifest, or signed artifact is committed here; this is
verification wiring, not a claim that a release has been signed.

The pinned public key fingerprint lives in `src/scrub/controlled-release.ts`
(`controlledScrubberPublicKeySha256`). It must match `publicKeySha256` in this
metadata, or `vibebloat init` rejects the release as uncontrolled.
