import type { HistoryChunk } from "./types";

/**
 * Gate G: the cheap marker scan that decides what the model ever sees.
 *
 * Two families of signal, because incidents surface either way:
 *  - explicit failure vocabulary emitted by tools, and
 *  - human frustration, which is free labeled training data — a person only
 *    snaps at an agent right after it broke something.
 *
 * Precision is deliberately imperfect; the model pass is the real classifier.
 * The bar here is recall without waving through ordinary conversation.
 */

/** Tool/runtime failure vocabulary. Bare "fix"/"break"/"retry" are excluded: they dominate normal requests. */
const failureSignals = /\b(fail(?:ed|ure|s)?|error|exception|traceback|broke|broken|crashed?|timed?\s?out|deadlock)\b|\[tool\]/i;

/**
 * Exasperation markers that carry a complaint on their own. Deliberately NOT a
 * general profanity list: measured against 1,981 real user messages, bare
 * profanity is a speech register ("just run the damn thing"), not an incident —
 * it flagged 16.2% of all traffic against a true incident rate near 3%. Every
 * real frustration sample in the corpus also carries a correction, a failure,
 * or a destructive outcome, so those signals do the work instead.
 */
const exasperationSignals = /\b(wtf|omfg|ffs|bullshit|for\s+fuck'?s\s+sake|are\s+you\s+kidding)\b/i;

/** Destructive outcomes the user is reporting after the fact. */
const destructionSignals = /\b(deleted|wiped|nuked|clobbered|overwr(?:ote|itten|ite)|destroyed|blew\s+away|lost\s+(?:my|all|the)|gone\s+forever|reverted\s+my)\b/i;

/**
 * Corrective speech acts: the user telling the agent it did the wrong thing.
 * Phrase-anchored so benign uses of the same words ("stop when u can") stay out.
 */
const correctionSignals = new RegExp(
  [
    "\\bstop\\s+(?:doing|that|it\\b)",
    "\\b(?:don't|dont|do\\s+not|never)\\s+(?:do|touch|run|use|delete|change)\\b",
    "\\bwhy\\s+(?:did|would|the\\s+hell)\\s+you\\b",
    "\\byou\\s+(?:just\\s+)?(?:deleted|broke|removed|overwrote|ruined|ignored)\\b",
    "\\bi\\s+(?:said|told\\s+you|already\\s+said)\\b",
    "\\bget\\s+rid\\s+of\\b",
    "\\brevert\\s+(?:back|to|it|that|the)\\b",
    "\\bthat'?s\\s+not\\s+what\\s+i\\b",
    "\\b(?:again|still)\\s*[?!]",
    "\\bsupposed\\s+to\\b",
    "\\byou\\s+(?:keep|always|still)\\b",
    "\\byou\\s+(?:don'?t|didn'?t|can'?t)\\s+\\w+",
    "\\bthat'?s\\s+not\\b",
    "\\bnot\\s+what\\s+i\\b",
    "\\bno,?\\s+i\\s+(?:said|meant|want|need|asked)\\b",
    "\\bwhy\\s+(?:is|are|does|did)\\s+(?:it|this|that|there)\\b",
  ].join("|"),
  "i",
);

/**
 * Shouted correction: a capitalized negation that terminates a clause, as in
 * "NO!" or "STOP.". Requires the punctuation — bare capitalized NO appears
 * inside ordinary sentences ("1 iF NO security issue") and is not a signal.
 */
const shoutedSignals = /(?:^|[\s.!?])(?:NO|STOP|WTF)[.!]/;

const incidentSignals = [failureSignals, exasperationSignals, destructionSignals, correctionSignals, shoutedSignals];

export function hasIncidentSignal(content: string): boolean {
  return incidentSignals.some((signal) => signal.test(content));
}

export function prefilterCandidates(chunks: HistoryChunk[]): HistoryChunk[] {
  return chunks.filter((chunk) => hasIncidentSignal(chunk.content));
}
