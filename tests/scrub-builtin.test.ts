import { expect, test } from "bun:test";
import { builtinRedact, builtinPresidioScrubber, builtinGitleaksScrubber, HIGH_ENTROPY_MIN_LENGTH } from "../src/scrub/builtin";

test("redacts bearer tokens", () => {
  const { payload, findings } = builtinRedact("curl -H 'Authorization: Bearer sk_live_9wQ2xTvB7nRk' api");
  expect(payload).not.toContain("sk_live_9wQ2xTvB7nRk");
  expect(payload).toContain("<redacted>");
  expect(findings.some((finding) => finding.name === "bearer")).toBe(true);
});

test("redacts provider key formats the old pattern list missed", () => {
  const secrets = [
    "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    "github_pat_11ABCDEFG0aBcDeFgHiJkL_MnOpQrStUvWxYz0123456789AbCdEfGhIjKlMnOp",
    "xoxb-2451234567-2451234567-QWERTYuiopASDFghjklZXCVb",
    "AKIAIOSFODNN7EXAMPLE",
    "sk-ant-api03-abcDEFghiJKLmnoPQRstuVWXyz0123456789-_abcDEFghiJKLmnoPQRst",
  ];
  for (const secret of secrets) {
    const { payload } = builtinRedact(`the key is ${secret} ok`);
    expect(payload).not.toContain(secret);
  }
});

test("redacts unknown high-entropy credentials with no recognizable prefix", () => {
  const secret = "Zt9kQw3LmXp7Vb2NrJd8FyHc4TgSaEuW";
  expect(secret.length).toBeGreaterThanOrEqual(HIGH_ENTROPY_MIN_LENGTH);
  const { payload, findings } = builtinRedact(`deploy --credential ${secret} now`);
  expect(payload).not.toContain(secret);
  expect(findings.some((finding) => finding.name === "high_entropy")).toBe(true);
});

test("leaves ordinary prose and commands intact", () => {
  const text = "git stash -u deleted my untracked launchers and I was furious about it";
  expect(builtinRedact(text).payload).toBe(text);
});

test("does not redact long ordinary words as entropy", () => {
  const text = "internationalization and counterrevolutionaries are long but harmless";
  expect(builtinRedact(text).payload).toBe(text);
});

test("presidio scrubber returns the redacted payload", async () => {
  const scrubbed = await builtinPresidioScrubber()("email me at hunter@example.com");
  expect(scrubbed).not.toContain("hunter@example.com");
});

test("gitleaks scrubber fails closed when a secret survives redaction", async () => {
  const scrubber = builtinGitleaksScrubber();
  await expect(scrubber("Bearer notredacted-token-value")).resolves.toContain("<redacted>");
  const leaky = builtinGitleaksScrubber({ redact: (text) => ({ payload: text, findings: [] }) });
  await expect(leaky("Authorization: Bearer leaked_secret_value")).rejects.toThrow(/secret/i);
});
