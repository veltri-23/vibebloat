const word = /[a-z0-9][a-z0-9-]{2,}/g;

function words(value: string): Set<string> {
  return new Set(value.toLowerCase().match(word) ?? []);
}

function plain(paragraph: string): string {
  return paragraph
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/[`*_>]/g, "")
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

export function lookupMarkdownAnswer(message: string, markdown: string, maximumLength = 320): string | undefined {
  const query = words(message);
  if (query.size === 0 || maximumLength < 40) return undefined;
  let best: { score: number; text: string } | undefined;
  for (const source of markdown.split(/\r?\n\s*\r?\n/)) {
    if (source.trimStart().startsWith("```")) continue;
    const text = plain(source);
    if (!text) continue;
    const score = [...words(text)].filter((token) => query.has(token)).length;
    if (score > 0 && (!best || score > best.score)) best = { score, text };
  }
  if (!best) return undefined;
  if (best.text.length <= maximumLength) return best.text;
  const clipped = best.text.slice(0, maximumLength + 1);
  const boundary = Math.max(clipped.lastIndexOf(". "), clipped.lastIndexOf("? "), clipped.lastIndexOf("! "));
  return `${clipped.slice(0, boundary >= 40 ? boundary + 1 : maximumLength).trimEnd()}…`;
}
