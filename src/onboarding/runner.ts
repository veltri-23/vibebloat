export function nextGateBatch<Gate>(orderedGates: Gate[], offset: number, maximum = 3): Gate[] {
  if (maximum < 1 || maximum > 3) throw new Error("Onboarding gate batch must contain one to three gates.");
  return orderedGates.slice(offset, offset + maximum);
}
