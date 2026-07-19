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

// Formats an independent reviewer confirmed were reaching the model verbatim.
test("redacts credentials embedded in connection strings", () => {
  for (const uri of [
    "DATABASE_URL=postgres://appuser:hunter2Password@localhost:5432/appdb",
    "mongodb+srv://admin:s3cr3t@cluster0.mongodb.net/test",
    "redis://default:mypass@10.0.0.4:6379",
  ]) {
    const { payload } = builtinRedact(uri);
    expect(payload).not.toContain("hunter2Password");
    expect(payload).not.toContain("s3cr3t");
    expect(payload).not.toContain("mypass");
  }
});

test("redacts Basic and Token authorization headers, not only Bearer", () => {
  expect(builtinRedact("Authorization: Basic dXNlcjpwYXNzd29yZA==").payload).not.toContain("dXNlcjpwYXNzd29yZA==");
  expect(builtinRedact("Authorization: Token abc123def456ghi789").payload).not.toContain("abc123def456ghi789");
});

test("redacts UUID-shaped credentials that sit under the entropy threshold", () => {
  const { payload } = builtinRedact("vibebloat key 550e8400-e29b-41d4-a716-446655440000");
  expect(payload).not.toContain("550e8400-e29b-41d4-a716-446655440000");
});

test("redacts common password keyword aliases", () => {
  for (const line of ["passwd: hunter2", "pwd=letmein123", "pass: correcthorse", "client_secret: abc123xyz"]) {
    const { payload } = builtinRedact(line);
    for (const value of ["hunter2", "letmein123", "correcthorse", "abc123xyz"]) {
      if (line.includes(value)) expect(payload).not.toContain(value);
    }
  }
});

test("does not shred ordinary URLs into false secrets", () => {
  const url = "curl https://api.github.com/repos/veltri-23/antibody/issues";
  expect(builtinRedact(url).payload).toContain("api.github.com");
});

test("leaves slash commands alone", () => {
  expect(builtinRedact("run /gsd-plan-phase then /ship").payload).toBe("run /gsd-plan-phase then /ship");
});

// The model must still be able to tell WHICH file an incident destroyed.
test("preserves the final path segment so incidents stay specific", () => {
  const windows = builtinRedact("git stash -u deleted D:\\AI\\AIOS\\launchers").payload;
  expect(windows).toContain("launchers");
  expect(windows).not.toContain("D:\\AI\\AIOS");
  const unix = builtinRedact("rm -rf /home/hunter/projects/jobs-pipeline").payload;
  expect(unix).toContain("jobs-pipeline");
  expect(unix).not.toContain("/home/hunter");
});

test("fail-closed check is broader than the redactor, not a subset of it", async () => {
  // A redactor bug must not silently pass these through.
  const leaky = builtinGitleaksScrubber({ redact: (text) => ({ payload: text, findings: [] }) });
  for (const secret of [
    "postgres://user:supersecretpw@host/db",
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "-----BEGIN RSA PRIVATE KEY-----MIIEow",
    "token=550e8400-e29b-41d4-a716-446655440000",
  ]) {
    await expect(leaky(secret)).rejects.toThrow(/secret/i);
  }
});
