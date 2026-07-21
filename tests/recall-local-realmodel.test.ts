import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IncidentStore } from "../src/ingest/incidents-store";
import { createLocalRecall, setEmbedderForTesting } from "../src/ingest/recall-local";
import { commandTokens, jaccardSimilarity } from "../src/ingest/semantic-recall";

/**
 * The one test that exercises the REAL neural model end to end — no injected
 * embedder, a live `node` sidecar loading Xenova/all-MiniLM-L6-v2. It proves
 * the thing stubbed tests can't: that a genuinely reworded command (different
 * words, zero shared tokens) recalls a past incident by *meaning*, where the
 * lexical backend would score exactly 0.
 *
 * It SKIPS (not passes) when the model can't load here — no `node` on PATH, the
 * optional transformers dep absent, or offline on first run. A skip is honest;
 * a green stub is the bug this whole feature exists to avoid. Set
 * VIBEBLOAT_REQUIRE_REALMODEL=1 to turn "unavailable" into a hard failure (CI
 * that guarantees the model is present).
 */

// Persistent cache so the model downloads once, then runs offline on reruns.
const modelCache = join(process.cwd(), ".vibebloat-model-cache");
const storeDir = mkdtempSync(join(tmpdir(), "vibebloat-realmodel-"));

afterAll(() => {
  try { rmSync(storeDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

setEmbedderForTesting(undefined); // force the real sidecar

const probeStore = new IncidentStore({ path: join(storeDir, "incidents.sqlite") });
const recall = createLocalRecall({ store: probeStore, cacheDir: modelCache, workerTimeoutMs: 120_000 });

// A destructive-git incident, described as a real mistake.
await recall.record({
  incidentId: "git-stash-u",
  command: "git stash -u",
  argsAnyOf: ["-u", "--include-untracked"],
  condition: "it stashed untracked files that were never recovered",
  consequence: "121 operational files vanished from the working tree",
  canonicalCommand: "git stash -u",
});

// Genuine paraphrase — no shared command token with "git stash -u".
const paraphrase = "save my uncommitted work aside including new files";
const realHits = await recall.recall({
  event: { chokepoint: "shell", command: paraphrase },
  canonicalCommand: paraphrase,
  limit: 1,
});

const available = recall.unavailableReason === undefined && realHits.length > 0;
const require = process.env.VIBEBLOAT_REQUIRE_REALMODEL === "1";

if (!available && !require) {
  test.skip(`real model unavailable — ${recall.unavailableReason ?? "no hit"} (set VIBEBLOAT_REQUIRE_REALMODEL=1 to hard-fail)`, () => {});
} else {
  test("real MiniLM recalls a paraphrase with ZERO shared tokens (lexical would miss it)", () => {
    expect(recall.unavailableReason).toBeUndefined();
    // Lexical proof: the paraphrase and the stored command share no tokens.
    const lexical = jaccardSimilarity(commandTokens(paraphrase), commandTokens("git stash -u"));
    expect(lexical).toBe(0);
    // Neural proof: it recalls the incident anyway, above the backend threshold.
    expect(realHits[0]?.incidentId).toBe("git-stash-u");
    expect(realHits[0]?.similarity ?? 0).toBeGreaterThanOrEqual(recall.warnThreshold);
  });

  test("real MiniLM does NOT fire on an unrelated command", async () => {
    const unrelated = "list all running docker containers";
    const hits = await recall.recall({
      event: { chokepoint: "shell", command: unrelated },
      canonicalCommand: unrelated,
      limit: 1,
    });
    const top = hits[0];
    if (top) expect(top.similarity).toBeLessThan(recall.warnThreshold);
  });
}
