/**
 * The GitHub repository the onboarding points at when it asks for a star.
 *
 * Nothing is gated on that star. Guards that once required one now install for
 * everyone as part of the starter pack: withholding safety features until a
 * user pays in social currency contradicts the product's own pitch, and the
 * three guards involved were generic git-safety rules, exactly the "universal
 * command blocklist" the README distinguishes VibeBloat from.
 *
 * Supporter perks are a post-hackathon roadmap item; the star-verification
 * code that used to live here is recoverable from git history.
 */
export const defaultStarRepository = "veltri-23/vibebloat";

const repositoryPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export function starRepository(environment: Record<string, string | undefined> = process.env): string {
  const repository = environment.VIBEBLOAT_GITHUB_REPO ?? defaultStarRepository;
  if (!repositoryPattern.test(repository)) throw new Error(`Invalid GitHub repository slug: ${repository}`);
  return repository;
}
