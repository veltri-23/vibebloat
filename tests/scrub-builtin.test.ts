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

// The pipeline scrubs a SERIALIZED payload and parses it back, so a
// replacement containing a backslash produces an invalid JSON escape and kills
// the whole scan. Found by dogfooding on real Windows transcripts.
test("redacted output survives a JSON round trip", () => {
  const chunks = [{ role: "user", content: String.raw`git stash -u deleted D:\AI\AIOS\launchers again` }];
  const scrubbed = builtinRedact(JSON.stringify(chunks)).payload;
  expect(() => JSON.parse(scrubbed)).not.toThrow();
  // The final segment still survives, so the incident stays specific.
  expect(scrubbed).toContain("launchers");
});

test("every redacted path token is backslash-free", () => {
  const paths = [
    String.raw`C:\Users\me\project\file.ts`,
    String.raw`D:\AI\notes`,
    "/home/hunter/projects/app",
    // UNC share: two leading backslashes, and previously matched no pattern.
    "\\\\server\\share\\file",
  ];
  for (const path of paths) {
    const { payload } = builtinRedact(path);
    expect(payload).toStartWith("<path>/");
    expect(payload).not.toContain("\\");
  }
});

// The pipeline hands the scrubber a SERIALIZED document. A prose-oriented
// pattern with a greedy tail eats the closing quote and brace, so the payload
// no longer parses and the whole scan dies before the model is ever called.
test("scrubbing a serialized document preserves its structure", () => {
  const document = JSON.stringify([
    { role: "user", content: "my token: abc123def456 and password=hunter2" },
    { role: "user", content: String.raw`git stash -u deleted D:\AI\launchers` },
  ]);
  const scrubbed = builtinRedact(document).payload;

  const parsed = JSON.parse(scrubbed) as Array<{ role: string; content: string }>;
  expect(parsed).toHaveLength(2);
  expect(parsed[0]!.role).toBe("user");
  expect(parsed[0]!.content).not.toContain("abc123def456");
  expect(parsed[0]!.content).not.toContain("hunter2");
  expect(parsed[1]!.content).toContain("launchers");
});

test("keys are never rewritten, only values", () => {
  const document = JSON.stringify({ token: "abc123def456", password: "hunter2", role: "user" });
  const parsed = JSON.parse(builtinRedact(document).payload) as Record<string, string>;
  expect(Object.keys(parsed).sort()).toEqual(["password", "role", "token"]);
  expect(parsed.token).not.toContain("abc123def456");
  expect(parsed.role).toBe("user");
});

// Real transcripts are full of prose like "all tests pass:" and "no pass".
// Treating that as an unredacted secret halts the user's entire scan with
// "Scrub failed, ingest paused" — found by dogfooding real history.
test("ordinary prose does not halt ingest", async () => {
  const scrubber = builtinGitleaksScrubber();
  for (const text of [
    "all tests pass: 5 failed: 0",
    "the second pass: mine candidates",
    "we should pass: true through",
  ]) {
    await expect(scrubber(text)).resolves.toBeString();
  }
});

test("a serialized document does not halt on structure adjacent to a keyword", async () => {
  const document = JSON.stringify([
    { content: "second pass:", timestamp: "2026-07-19T20:45:33.737Z" },
    { content: "nothing to see" },
  ]);
  await expect(builtinGitleaksScrubber()(document)).resolves.toBeString();
});

test("a real secret in a document still halts", async () => {
  const document = JSON.stringify([{ content: "Authorization: Bearer abcdefgh12345678" }]);
  const leaky = builtinGitleaksScrubber({ redact: (text) => ({ payload: text, findings: [] }) });
  await expect(leaky(document)).rejects.toThrow(/secret/i);
});

// Issue #55: real onboarding history contains assistant PROSE about keys, e.g.
// "...you'll rotate later. Don't paste keys like sk-xxxxxxxxxxxxxxxx...". The
// second-pass net matched the bare "sk-" prefix on a low-entropy placeholder
// and halted the ENTIRE 20k-chunk scan. Prose about secrets must pass clean.
test("prose that mentions keys does not halt ingest (#55)", async () => {
  const scrubber = builtinGitleaksScrubber();
  for (const prose of [
    "Set up your Zen key, you'll rotate later. Don't paste keys like sk-xxxxxxxxxxxxxxxx into chat.",
    "your api key placeholder sk-your-api-key-here goes in the env file",
    "keep the secret safe and rotate the token monthly, never paste keys anywhere",
  ]) {
    await expect(scrubber(prose)).resolves.toBeString();
  }
});

// The fix gates the prefix net on entropy, so genuine keys — which are
// high-entropy random runs — must STILL halt even when redaction is bypassed.
test("a real high-entropy provider key still halts when redaction is bypassed (#55)", async () => {
  const leaky = builtinGitleaksScrubber({ redact: (text) => ({ payload: text, findings: [] }) });
  for (const secret of [
    "sk-ant-api03-abcDEFghiJKLmnoPQRstuVWXyz0123456789-_abcDEFghiJKLmnoPQRst",
    "ghp_16C7e42F292c6912E7710c838347Ae178B4a",
    "AKIAIOSFODNN7EXAMPLE0",
  ]) {
    await expect(leaky(secret)).rejects.toThrow(/secret/i);
  }
});

// keyword: value credentials are structural, not entropy-gated, so a real
// one still halts regardless of how random the value is.
test("a real keyword:value credential still halts when redaction is bypassed (#55)", async () => {
  const leaky = builtinGitleaksScrubber({ redact: (text) => ({ payload: text, findings: [] }) });
  for (const secret of [
    "password: hunter2CorrectHorseBattery",
    "client_secret = a3f9c1b8e7d64k2m",
    "api_key: 550e8400-e29b-41d4-a716-446655440000",
  ]) {
    await expect(leaky(secret)).rejects.toThrow(/secret/i);
  }
});
