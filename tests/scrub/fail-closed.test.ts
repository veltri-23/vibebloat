import { describe, expect, test } from "bun:test";
import { ingestFailClosed } from "../../src/scrub/fail-closed";
import { createGitleaksCommandScrubber } from "../../src/scrub/gitleaks";
import { createPresidioCommandScrubber } from "../../src/scrub/presidio";

const rawHermesHistory = '{"Authorization":"Bearer secret-token"}';

function setup(failingScrubber: "presidio" | "gitleaks") {
  let modeled = 0;
  let published = 0;
  const local: string[] = [];
  return {
    options: {
      presidio: async (payload: string) => {
        if (failingScrubber === "presidio") throw new Error("presidio offline");
        return payload.replace("secret-token", "<redacted>");
      },
      gitleaks: async (payload: string) => {
        if (failingScrubber === "gitleaks") throw new Error("gitleaks unavailable");
        return payload;
      },
      storeLocal: async (payload: string) => { local.push(payload); },
      modelPass: async () => { modeled += 1; return { incident: "never" }; },
      publish: async () => { published += 1; },
    },
    counts: () => ({ modeled, published, local }),
  };
}

describe("CRITICAL: scrub failure closes ingestion", () => {
  test.each(["presidio", "gitleaks"] as const)("halts before model or publish when %s errors", async (failingScrubber) => {
    const { options, counts } = setup(failingScrubber);
    const result = await ingestFailClosed(rawHermesHistory, options);

    expect(result).toEqual({ status: "paused", message: "Scrub failed, ingest paused, fix and rerun" });
    expect(counts()).toEqual({ modeled: 0, published: 0, local: [rawHermesHistory] });
  });

  test("runs both scrubbers before model and only publishes redacted output", async () => {
    const calls: string[] = [];
    const result = await ingestFailClosed(rawHermesHistory, {
      presidio: async (payload) => { calls.push("presidio"); return payload.replace("secret-token", "<redacted>"); },
      gitleaks: async (payload) => { calls.push("gitleaks"); return payload; },
      storeLocal: async () => { throw new Error("should not store"); },
      modelPass: async (payload) => { calls.push(payload); return { incident: "safe" }; },
      publish: async (incident) => { calls.push(incident.incident); },
    });

    expect(result).toEqual({ status: "ingested" });
    expect(calls).toEqual(["presidio", "gitleaks", '{"Authorization":"Bearer <redacted>"}', "safe"]);
  });

  test("halts when a scrubber returns a malformed payload", async () => {
    const { options, counts } = setup("presidio");
    options.presidio = async () => undefined as unknown as string;

    await expect(ingestFailClosed(rawHermesHistory, options)).resolves.toEqual({
      status: "paused",
      message: "Scrub failed, ingest paused, fix and rerun",
    });
    expect(counts()).toEqual({ modeled: 0, published: 0, local: [rawHermesHistory] });
  });
});

describe("command scrubbers", () => {
  test("sends Presidio payload via stdin and accepts only JSON payload output", async () => {
    const scrub = createPresidioCommandScrubber(["presidio-wrapper", "--json"], async (command, input) => {
      expect(command).toEqual(["presidio-wrapper", "--json"]);
      expect(JSON.parse(input)).toEqual({ payload: rawHermesHistory });
      return { exitCode: 0, stdout: '{"payload":"safe"}', stderr: "" };
    });

    await expect(scrub(rawHermesHistory)).resolves.toBe("safe");
  });

  test("executes a command directly without a shell", async () => {
    const scrub = createPresidioCommandScrubber([
      "bun",
      "-e",
      "Bun.stdin.text().then((input) => console.log(input))",
    ]);

    await expect(scrub(rawHermesHistory)).resolves.toBe(rawHermesHistory);
  });

  test("fails closed on Gitleaks findings or malformed command output", async () => {
    const findings = createGitleaksCommandScrubber(["gitleaks-wrapper"], async () => ({
      exitCode: 0,
      stdout: '{"payload":"safe","findings":[{"rule":"token"}]}',
      stderr: "",
    }));
    const malformed = createGitleaksCommandScrubber(["gitleaks-wrapper"], async () => ({
      exitCode: 0,
      stdout: "not-json",
      stderr: "",
    }));

    await expect(findings(rawHermesHistory)).rejects.toThrow("Gitleaks returned an unsafe result");
    await expect(malformed(rawHermesHistory)).rejects.toThrow("Gitleaks returned invalid JSON");
  });
});
