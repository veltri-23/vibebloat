import { isUntrustedSemanticContext, type UntrustedSemanticContext } from "../ingest/semantic-context";
import type { HistoryChunk } from "../ingest/types";

export function serializeModelCommandInput(
  candidates: readonly HistoryChunk[],
  semanticContext?: UntrustedSemanticContext,
): string {
  if (semanticContext !== undefined && !isUntrustedSemanticContext(semanticContext)) {
    throw new Error("Model command requires validated semantic context");
  }
  return JSON.stringify({
    candidates,
    ...(semanticContext ? { semantic_context: semanticContext } : {}),
  });
}
