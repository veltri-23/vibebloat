export interface LocalIncident {
  class: "A" | "B" | "C" | "D";
  pattern: string;
  evidence: string;
}

export interface AnonymousIncident {
  class: LocalIncident["class"];
  pattern: string;
}

export function anonymizeIncident(incident: LocalIncident): AnonymousIncident {
  if (/bearer\s+\S+|api[_-]?key\s*[:=]|secret\s*[:=]/i.test(incident.evidence) && !incident.evidence.includes("<redacted>")) {
    throw new Error("Scrub required before anonymous stream.");
  }
  return { class: incident.class, pattern: incident.pattern };
}
