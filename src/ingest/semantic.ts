export interface RetrievalResult {
  source: "codebase-memory" | "local";
  results: string[];
}

export async function retrieveContext(query: string, queryGraph: (query: string) => Promise<string[]>, queryLocal: (query: string) => Promise<string[]>): Promise<RetrievalResult> {
  try {
    return { source: "codebase-memory", results: await queryGraph(query) };
  } catch {
    return { source: "local", results: await queryLocal(query) };
  }
}
