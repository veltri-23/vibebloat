import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestFailClosed } from "../../src/scrub/fail-closed";
import { createGitleaksCommandScrubber } from "../../src/scrub/gitleaks";
import { createLocalOnlySink } from "../../src/scrub/local-sink";
import { createPresidioCommandScrubber } from "../../src/scrub/presidio";

const rawHermesHistory = '{"Authorization":"Bearer secret-token"}';

async function setup(failingScrubber: "presidio" | "gitleaks") {
  let modeled = 0;
  let published = 0;
  const directory = await mkdtemp(join(tmpdir(), "vibebloat-fail-closed-"));
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
      localSink: createLocalOnlySink(directory),
      modelPass: async () => { modeled += 1; return { incident: "never" }; },
      publish: async () => { published += 1; },
    },
    counts: () => ({ modeled, published }),
    readLocal: async () => readFile(join(directory, (await readdir(directory))[0]), "utf8"),
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

describe("CRITICAL: scrub failure closes ingestion", () => {
  test.each(["presidio", "gitleaks"] as const)("halts before model or publish when %s errors", async (failingScrubber) => {
    const { options, counts, readLocal, cleanup } = await setup(failingScrubber);
    try {
      const result = await ingestFailClosed(rawHermesHistory, options);

      expect(result).toEqual({ status: "paused", message: "Scrub failed, ingest paused, fix and rerun" });
      expect(counts()).toEqual({ modeled: 0, published: 0 });
      expect(await readLocal()).toBe(rawHermesHistory);
    } finally {
      await cleanup();
    }
  });

  test("runs both scrubbers before model and only publishes redacted output", async () => {
    const calls: string[] = [];
    const directory = await mkdtemp(join(tmpdir(), "vibebloat-fail-closed-"));
    try {
      const result = await ingestFailClosed(rawHermesHistory, {
      presidio: async (payload) => { calls.push("presidio"); return payload.replace("secret-token", "<redacted>"); },
      gitleaks: async (payload) => { calls.push("gitleaks"); return payload; },
      localSink: createLocalOnlySink(directory),
      modelPass: async (payload) => { calls.push(payload); return { incident: "safe" }; },
      publish: async (incident) => { calls.push(incident.incident); },
      });

      expect(result).toEqual({ status: "ingested" });
      expect(calls).toEqual(["presidio", "gitleaks", '{"Authorization":"Bearer <redacted>"}', "safe"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("halts when a scrubber returns a malformed payload", async () => {
    const { options, counts, readLocal, cleanup } = await setup("presidio");
    try {
      options.presidio = async () => undefined as unknown as string;

      await expect(ingestFailClosed(rawHermesHistory, options)).resolves.toEqual({
        status: "paused",
        message: "Scrub failed, ingest paused, fix and rerun",
      });
      expect(counts()).toEqual({ modeled: 0, published: 0 });
      expect(await readLocal()).toBe(rawHermesHistory);
    } finally {
      await cleanup();
    }
  });

  test("rejects a non-local sink before any raw payload is processed", async () => {
    let modeled = 0;
    let published = 0;
    await expect(ingestFailClosed(rawHermesHistory, {
      presidio: async () => { throw new Error("should not run"); },
      gitleaks: async () => { throw new Error("should not run"); },
      localSink: { store: async () => {} } as never,
      modelPass: async () => { modeled += 1; return { incident: "never" }; },
      publish: async () => { published += 1; },
    })).rejects.toThrow("A concrete local-only sink is required");
    expect({ modeled, published }).toEqual({ modeled: 0, published: 0 });
  });
});

describe("command scrubbers", () => {
  test("sends Presidio payload via stdin and accepts only a redacted JSON payload", async () => {
    const scrub = createPresidioCommandScrubber(["presidio-wrapper", "--json"], async (command, input) => {
      expect(command).toEqual(["presidio-wrapper", "--json"]);
      expect(JSON.parse(input)).toEqual({ payload: rawHermesHistory });
      return { exitCode: 0, stdout: '{"payload":"safe"}', stderr: "" };
    });

    await expect(scrub(rawHermesHistory)).resolves.toBe("safe");
  });

  test("fails closed when Presidio reports findings", async () => {
    const scrub = createPresidioCommandScrubber(["presidio-wrapper"], async () => ({
      exitCode: 0,
      stdout: '{"payload":"safe","findings":[{"entity_type":"SECRET"}]}',
      stderr: "",
    }));

    await expect(scrub(rawHermesHistory)).rejects.toThrow("Presidio returned an unsafe result");
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
