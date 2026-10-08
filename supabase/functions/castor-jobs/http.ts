export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  // En-têtes envoyés par supabase-js (liste de @supabase/supabase-js/cors) + secret des tâches planifiées.
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage, x-castor-cron',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message);
  return String(e);
}
