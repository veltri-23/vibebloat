export interface GatePrompt {
  question: string;
  options: string[];
}

export interface AssistContext extends GatePrompt {
  lookup(message: string): string | undefined;
}

export function answerAssist(message: string, context: AssistContext): GatePrompt & { answer: string } {
  const answer = context.lookup(message) ?? "I can explain the options, recommend one, or apply the recommended option. Want more detail?";
  return { answer: answer.endsWith("Want more detail?") ? answer : `${answer} Want more detail?`, question: context.question, options: context.options };
}
