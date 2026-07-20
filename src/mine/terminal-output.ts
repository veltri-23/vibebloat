const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);

/** OSC sequence (window title), terminated by BEL or ST. */
const osc = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
/** CSI sequence: colour, cursor movement, spinner frames. */
const csi = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
/** Remaining two-character escapes. */
const shortEscape = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");
/** Any other C0 control, keeping tab and newline. */
const otherControl = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f]", "g");

/**
 * Strips terminal control output from a model command's stdout.
 *
 * `ollama run` — the command behind the advertised free local route — writes a
 * progress spinner to stdout even when its output is piped, so the incident
 * manifest arrived wrapped in escape codes and every local scan failed to
 * parse. Any CLI-wrapped model can do this, so it is cleaned centrally rather
 * than special-cased per provider.
 */
export function stripTerminalControl(text: string): string {
  return text
    .replace(osc, "")
    .replace(csi, "")
    .replace(shortEscape, "")
    // Progress lines rewritten in place with a carriage return.
    .replace(/\r/g, "\n")
    .replace(otherControl, "");
}
