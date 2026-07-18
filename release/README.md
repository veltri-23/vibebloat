# Controlled release verification

`release/metadata.json` is created only with a controlled release. It must contain:

```json
{
  "schemaVersion": 1,
  "version": "0.1.0",
  "artifact": "dist/vibebloat",
  "signature": "dist/vibebloat.sig",
  "publicKey": "release/vibebloat.pub",
  "publicKeySha256": "lowercase SHA-256 of exact public-key bytes"
}
```

Workflow dispatch validates metadata, hashes exact public-key bytes, then runs `cosign verify-blob`. No key, signature, or signed artifact is committed here; this is verification wiring, not a claim that a release has been signed.
