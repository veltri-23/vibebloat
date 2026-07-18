import { expect, test } from "bun:test";

test("baseline site publishes local-first privacy and deletion controls", async () => {
  const page = await Bun.file(new URL("../site/privacy.html", import.meta.url)).text();
  const policy = await Bun.file(new URL("../PRIVACY.md", import.meta.url)).text();
  const home = await Bun.file(new URL("../site/index.html", import.meta.url)).text();

  for (const text of [page, policy]) {
    expect(text).toContain("Presidio");
    expect(text).toContain("Gitleaks");
    expect(text).toContain("vibebloat email --forget");
    expect(text).toContain("vibebloat uninstall --yes");
  }
  expect(home).toContain('href="privacy.html"');
});
