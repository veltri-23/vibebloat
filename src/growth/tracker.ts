import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { replaceGuardAtomically } from "../compiler/live-compile";

export interface TelemetryEvent {
  type: "guard-fired";
  guardId: string;
  agent: string;
}

const filename = "telemetry.json";

export function readTelemetry(directory: string): TelemetryEvent[] {
  const path = join(directory, filename);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as TelemetryEvent[] : [];
}

export function appendTelemetry(directory: string, event: TelemetryEvent): void {
  replaceGuardAtomically(join(directory, filename), `${JSON.stringify([...readTelemetry(directory), event])}\n`);
}
