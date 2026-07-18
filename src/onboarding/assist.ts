export interface GatePrompt {
  question: string;
  options: string[];
}

export interface AssistContext extends GatePrompt {
  lookup?(message: string): string | undefined;
  faq?(message: string): string | undefined;
  repo?(message: string): string | undefined;
  reasoning?(message: string): string | undefined;
  recommendedOption?: string;
  applyRecommended?(choice: string): void;
}

export interface AssistResponse extends GatePrompt {
  answer: string;
  appliedOption?: string;
}

export function answerAssist(message: string, context: AssistContext): AssistResponse {
  const answer = context.faq?.(message) ?? context.repo?.(message) ?? context.lookup?.(message) ?? context.reasoning?.(message)
    ?? "I can explain the options, recommend one, or apply the recommended option.";
  const apply = /recommend and apply|apply (?:the )?recommended/i.test(message) && context.recommendedOption;
  if (apply) context.applyRecommended?.(apply);
  const complete = `${answer}${apply ? ` Applied: ${apply}.` : ""}`;
  return { answer: complete.endsWith("Want more detail?") ? complete : `${complete} Want more detail?`, question: context.question, options: context.options, ...(apply ? { appliedOption: apply } : {}) };
}
