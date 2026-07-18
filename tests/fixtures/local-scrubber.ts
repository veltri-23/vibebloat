const kind = process.argv[2];
const { payload } = JSON.parse(await Bun.stdin.text()) as { payload: string };

process.stdout.write(`${JSON.stringify({
  payload: kind === "presidio" ? payload.replace("secret-token", "<redacted>") : payload,
  findings: [],
})}\n`);
