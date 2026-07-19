import type { Event, Guard } from "../types";

/**
 * The event a guard is proved against before it is installed.
 *
 * It must include the arguments the guard requires. Building it from the bare
 * command means any guard with argsContains fails its own proof and is
 * rejected at compile time — which is exactly what a precise mined guard
 * looks like.
 */
export function syntheticEvent(guard: Guard): Event {
  if (guard.match.chokepoint === "file") {
    return { chokepoint: "file", path: guard.match.path };
  }
  const required = guard.match.argsContains ?? [];
  const any = guard.match.argsAnyOf?.slice(0, 1) ?? [];
  return {
    chokepoint: "shell",
    command: [guard.match.command, ...required, ...any]
      .filter((part): part is string => Boolean(part))
      .join(" "),
  };
}
