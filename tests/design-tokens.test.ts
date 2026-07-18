import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

function luminance(hex: string): number {
  const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => parseInt(value, 16) / 255) ?? [];
  const [red, green, blue] = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

function contrast(left: string, right: string): number {
  const first = luminance(left);
  const second = luminance(right);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

test("locked design tokens reach the site and accent meets WCAG AA", () => {
  const tokens = readFileSync(new URL("../src/styles/tokens.css", import.meta.url), "utf8");
  const site = readFileSync(new URL("../site/styles.css", import.meta.url), "utf8");

  for (const token of ["#1a1a1a", "#404040", "#fafaf7", "#f4f3ee", "#e6e4dc", "#c44601", "#d63841", "#f59e0b", "#2d7a3d"]) {
    expect(tokens).toContain(token);
    expect(site).toContain(token);
  }
  expect(tokens).toContain("IBM Plex Serif");
  expect(tokens).toContain("IBM Plex Sans");
  expect(tokens).toContain("JetBrains Mono");
  expect(contrast("#c44601", "#fafaf7")).toBeGreaterThanOrEqual(4.5);
});
