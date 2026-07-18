export type ReceiptCategory = "A" | "B" | "C" | "D";

export type ReceiptSharingPreference =
  | { mode: "local-only" }
  | { mode: "opted-in" };

export interface ReceiptObservation {
  category: ReceiptCategory;
  occurredAt: string;
}

export interface ReceiptWindow {
  startsAt: string;
  endsAt: string;
}

export interface ShareableReceiptPayload {
  window: ReceiptWindow;
  counts: Record<ReceiptCategory, number>;
}

const weekMilliseconds = 7 * 24 * 60 * 60 * 1_000;
const categories: readonly ReceiptCategory[] = ["A", "B", "C", "D"];

export function weeklyReceiptWindow(endsAt: Date): ReceiptWindow {
  if (Number.isNaN(endsAt.getTime())) throw new TypeError("Receipt window end must be a valid timestamp.");
  return {
    startsAt: new Date(endsAt.getTime() - weekMilliseconds).toISOString(),
    endsAt: endsAt.toISOString(),
  };
}

export function aggregateShareableReceipt(
  preference: ReceiptSharingPreference,
  window: ReceiptWindow,
  observations: Iterable<ReceiptObservation>,
): ShareableReceiptPayload | undefined {
  if (preference.mode !== "opted-in") return undefined;

  const startsAt = timestamp(window.startsAt, "start");
  const endsAt = timestamp(window.endsAt, "end");
  if (startsAt >= endsAt) throw new TypeError("Receipt window start must be before its end.");

  const counts: Record<ReceiptCategory, number> = { A: 0, B: 0, C: 0, D: 0 };
  for (const observation of observations) {
    if (!categories.includes(observation.category)) throw new TypeError("Receipt category is invalid.");
    const occurredAt = timestamp(observation.occurredAt, "observation");
    if (occurredAt >= startsAt && occurredAt < endsAt) counts[observation.category] += 1;
  }

  return {
    window: { startsAt: window.startsAt, endsAt: window.endsAt },
    counts,
  };
}

function timestamp(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new TypeError(`Receipt ${label} timestamp must be valid.`);
  return parsed;
}
