export type Scrubber = (payload: string) => Promise<string>;

export async function scrubWithPresidio(payload: string, scrub: Scrubber): Promise<string> {
  return scrub(payload);
}
