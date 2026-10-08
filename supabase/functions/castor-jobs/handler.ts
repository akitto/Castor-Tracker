// Routage, authentification et journalisation des tâches de castor-jobs.
import { CORE_VERSION, parisClock } from '../_shared/core/index.ts';
import { must, serviceClient, toJson, type Db } from './db.ts';
import { corsHeaders, errorMessage, HttpError, json } from './http.ts';
import { TASKS, type Caller, type JobContext, type JobResult } from './tasks.ts';

function decodeJwtPayload(token: string): Record<string, unknown> {
  const part = token.split('.')[1];
  if (!part) return {};
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return {};
  }
}

async function authenticate(req: Request, db: Db): Promise<Caller> {
  const cronSecret = req.headers.get('x-castor-cron');
  if (cronSecret) {
    const ok = await must(db.rpc('castor_verify_cron_secret', { p_secret: cronSecret }), 'secret planifié');
    if (ok !== true) throw new HttpError(401, 'secret des tâches planifiées invalide');
    return { trigger: 'cron', userId: null };
  }
  const token = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '').trim();
  if (!token) throw new HttpError(401, 'authentification requise');
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, 'session invalide ou expirée');
  const [role, config] = await Promise.all([
    must(db.from('user_roles').select('role').eq('user_id', data.user.id).maybeSingle(), 'rôle'),
    must(db.from('app_config').select('admin_mfa_required').maybeSingle(), 'réglages'),
  ]);
  if ((role as { role: string } | null)?.role !== 'admin') throw new HttpError(403, 'réservé aux administrateurs');
  const mfaRequired = (config as { admin_mfa_required: boolean } | null)?.admin_mfa_required ?? true;
  if (mfaRequired && decodeJwtPayload(token).aal !== 'aal2') {
    throw new HttpError(403, 'second facteur (TOTP) requis pour l’administration');
  }
  return { trigger: 'admin', userId: data.user.id };
}

async function withJobLog(ctx: JobContext, job: string, run: () => Promise<JobResult>): Promise<JobResult> {
  const started = await must(
    ctx.db
      .from('job_runs')
      .insert({ job, trigger: ctx.caller.trigger, requested_by: ctx.caller.userId, status: 'running' })
      .select('id')
      .single(),
    'journal',
  );
  const id = (started as { id: number }).id;
  try {
    const result = await run();
    await ctx.db
      .from('job_runs')
      .update({
        status: 'success',
        finished_at: new Date().toISOString(),
        message: result.message,
        details: result.details ? toJson(result.details) : null,
      })
      .eq('id', id);
    return { ...result, runId: id };
  } catch (e) {
    await ctx.db
      .from('job_runs')
      .update({ status: 'error', finished_at: new Date().toISOString(), message: errorMessage(e) })
      .eq('id', id);
    throw e;
  }
}

/**
 * Au premier appel d'un administrateur, enregistre dans Vault l'adresse des fonctions (et, si besoin, le secret
 * et les tâches planifiées) : l'installation par l'éditeur SQL de Supabase Cloud n'a rien à saisir à la main.
 * Sans effet si la configuration existe déjà (scripts/configure-supabase.sh en auto-hébergement).
 */
let endpointRegistered = false;
async function registerEndpoint(db: Db): Promise<void> {
  const url = Deno.env.get('SUPABASE_URL');
  if (endpointRegistered || !url) return;
  const { error } = await db.rpc('castor_register_endpoint', { p_url: `${url.replace(/\/+$/, '')}/functions/v1` });
  if (error) console.error('castor-jobs : enregistrement de l’adresse des fonctions :', error.message);
  else endpointRegistered = true;
}

export async function handle(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method === 'GET') return json({ ok: true, service: 'castor-jobs', core: CORE_VERSION });
  if (req.method !== 'POST') return json({ error: 'méthode non autorisée' }, 405);
  let task = '';
  try {
    const body = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
    task = String(body.task ?? '');
    const def = TASKS[task];
    if (!def) throw new HttpError(400, `tâche inconnue : ${task || '(vide)'}`);
    const db = serviceClient();
    const caller = await authenticate(req, db);
    if (caller.trigger === 'cron' && !def.cron) throw new HttpError(403, `tâche ${task} non planifiable`);
    if (caller.trigger === 'admin') await registerEndpoint(db);
    const now = new Date();
    const ctx: JobContext = { db, caller, body, clock: parisClock(now), now };
    if (caller.trigger === 'cron' && def.gate) {
      const reason = await def.gate(ctx);
      if (reason) return json({ task, skipped: reason });
    }
    const result = def.log === false ? await def.run(ctx) : await withJobLog(ctx, task, () => def.run(ctx));
    return json({ task, ...result });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(`castor-jobs ${task} :`, e);
    return json({ task, error: errorMessage(e) }, status);
  }
}

