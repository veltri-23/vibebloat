import { handleAnonymousIngestRequest } from "../src/growth/ingest-endpoint";
import { createSupabaseIngestStore } from "../src/growth/supabase-store";

export default {
  fetch(request: Request): Promise<Response> {
    const store = createSupabaseIngestStore(process.env);
    return handleAnonymousIngestRequest(request, { store });
  },
};
