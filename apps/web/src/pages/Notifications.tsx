import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { stampShort } from '../lib/format';
import { browserSubscription, disablePush, enablePush, isStandalone, pushSupport, saveSubscription } from '../lib/push';
import {
  runJob,
  supabase,
  unwrap,
  type NotificationPrefRow,
  type NotificationSettingsRow,
  type NotificationTypeRow,
} from '../lib/supabase';

type Message = { ok: boolean; text: string } | null;

export function Switch({ checked, onChange, label, disabled, hint }: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
  hint?: ReactNode;
}) {
  return (
    <label className="switch">
      <input type="checkbox" role="switch" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch__track" aria-hidden="true"><span className="switch__thumb" /></span>
      <span className="switch__text">
        <span className="switch__label">{label}</span>
        {hint && <span className="switch__hint">{hint}</span>}
      </span>
    </label>
  );
}

type Settings = Pick<NotificationSettingsRow, 'enabled' | 'quiet_hours' | 'webhook_enabled' | 'webhook_url' | 'webhook_format' | 'webhook_secret'>;
const DEFAULT_SETTINGS: Settings = { enabled: true, quiet_hours: true, webhook_enabled: false, webhook_url: null, webhook_format: 'json', webhook_secret: null };

/** Seuils des alertes personnelles, enregistrés dans params. */
function ParamsEditor({ type, params, disabled, onSave }: {
  type: string;
  params: Record<string, unknown>;
  disabled: boolean;
  onSave: (p: Record<string, unknown>) => Promise<void>;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => {
    setDraft(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v === null || v === undefined ? '' : String(v).replace('.', ',')])));
  }, [params]);
  const fields = type === 'estimate_move'
    ? [['threshold', 'Seuil de variation (€)', '0,50']]
    : type === 'price_alert'
      ? [['above', 'Alerte au-dessus de (€)', 'ex. 130'], ['below', 'Alerte en dessous de (€)', 'ex. 110']]
      : [];
  if (fields.length === 0) return null;
  async function submit(e: FormEvent) {
    e.preventDefault();
    const out: Record<string, unknown> = {};
    for (const [k] of fields) {
      const raw = (draft[k] ?? '').trim().replace(',', '.');
      out[k] = raw === '' ? null : Number(raw);
      if (out[k] !== null && (!Number.isFinite(out[k]) || (out[k] as number) <= 0)) return;
    }
    await onSave(out);
  }
  return (
    <form className="inline pref-params" onSubmit={submit}>
      {fields.map(([k, label, placeholder]) => (
        <label key={k} className="field">{label}
          <input inputMode="decimal" className="mono" style={{ width: 130 }} placeholder={placeholder} disabled={disabled}
            value={draft[k] ?? ''} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })} />
        </label>
      ))}
      <button type="submit" className="btn btn--small" disabled={disabled}>Enregistrer</button>
    </form>
  );
}

/** Préférences de notification de chaque compte : appareil, interrupteur général, un interrupteur par type, webhook (admins). */
export default function Notifications() {
  const { session, access } = useAuth();
  const qc = useQueryClient();
  const userId = session?.user.id ?? '';
  const isAdminRole = access?.role === 'admin';
  const [message, setMessage] = useState<Message>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [endpoint, setEndpoint] = useState<string | null>(null);
  const [support, setSupport] = useState(pushSupport());

  const types = useQuery({
    queryKey: ['notif', 'types'],
    queryFn: async () => unwrap(await supabase.from('notification_types').select('*').order('sort')) as NotificationTypeRow[],
  });
  const settings = useQuery({
    queryKey: ['notif', 'settings', userId],
    enabled: Boolean(userId),
    queryFn: async () => unwrap(await supabase.from('notification_settings').select('*').eq('user_id', userId).maybeSingle()) as NotificationSettingsRow | null,
  });
  const prefs = useQuery({
    queryKey: ['notif', 'prefs', userId],
    enabled: Boolean(userId),
    queryFn: async () => unwrap(await supabase.from('notification_prefs').select('*').eq('user_id', userId)) as NotificationPrefRow[],
  });
  const devices = useQuery({
    queryKey: ['notif', 'devices', userId],
    enabled: Boolean(userId),
    queryFn: async () => unwrap(await supabase.from('push_subscriptions')
      .select('id, endpoint, user_agent, created_at, last_success_at, last_error, failures').eq('user_id', userId).order('created_at')),
  });
  const recent = useQuery({
    queryKey: ['notif', 'recent', userId],
    enabled: Boolean(userId),
    queryFn: async () => unwrap(await supabase.from('v_my_notifications').select('*').order('created_at', { ascending: false }).limit(20)),
  });

  // Abonnement du navigateur ; s'il est connu du serveur, ses clés sont rafraîchies.
  useEffect(() => {
    void browserSubscription().then((sub) => setEndpoint(sub?.endpoint ?? null)).catch(() => setEndpoint(null));
  }, []);
  const thisDevice = devices.data?.find((d) => d.endpoint === endpoint) ?? null;
  useEffect(() => {
    if (!thisDevice) return;
    void browserSubscription().then((sub) => (sub ? saveSubscription(sub) : undefined)).catch(() => undefined);
  }, [thisDevice?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const s: Settings = { ...DEFAULT_SETTINGS, ...(settings.data ?? {}) };
  const prefOf = (t: NotificationTypeRow) => prefs.data?.find((p) => p.type === t.code);
  const enabledOf = (t: NotificationTypeRow) => prefOf(t)?.enabled ?? t.default_enabled;

  async function act(key: string, fn: () => Promise<unknown>, ok?: string) {
    setBusy(key);
    setMessage(null);
    try {
      await fn();
      if (ok) setMessage({ ok: true, text: ok });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
      await qc.invalidateQueries({ queryKey: ['notif'] });
    }
  }

  const saveSettings = (patch: Partial<NotificationSettingsRow>) =>
    act('settings', async () => {
      unwrap(await supabase.from('notification_settings').upsert({ user_id: userId, ...patch }, { onConflict: 'user_id' }));
    });

  const savePref = (t: NotificationTypeRow, patch: { enabled?: boolean; params?: Record<string, unknown> }) =>
    act(`pref-${t.code}`, async () => {
      const cur = prefOf(t);
      unwrap(await supabase.from('notification_prefs').upsert({
        user_id: userId,
        type: t.code,
        enabled: patch.enabled ?? cur?.enabled ?? t.default_enabled,
        params: (patch.params ?? cur?.params ?? {}) as NotificationPrefRow['params'],
      }, { onConflict: 'user_id,type' }));
    }, patch.params ? 'Seuils enregistrés.' : undefined);

  async function turnOn() {
    await act('device', async () => {
      await enablePush();
      const sub = await browserSubscription();
      setEndpoint(sub?.endpoint ?? null);
    }, 'Notifications activées sur cet appareil.');
    setSupport(pushSupport());
  }
  async function turnOff() {
    await act('device', async () => {
      await disablePush();
      setEndpoint(null);
    }, 'Cet appareil ne recevra plus de notifications.');
  }
  async function test() {
    await act('test', async () => {
      const res = await runJob('push-test', endpoint ? { endpoint } : {});
      if (res.ok === false) throw new Error(res.message ?? 'échec');
      setMessage({ ok: true, text: `${res.message ?? 'Envoyée'}. Elle doit apparaître dans quelques secondes.` });
    });
  }

  const userTypes = (types.data ?? []).filter((t) => t.audience === 'all');
  const adminTypes = (types.data ?? []).filter((t) => t.audience === 'admin');
  const master = s.enabled;

  const typeList = (list: NotificationTypeRow[]) => (
    <div className="pref-list">
      {list.map((t) => {
        const on = enabledOf(t);
        return (
          <div key={t.code} className="pref-row">
            <Switch
              checked={on}
              disabled={!master || busy === `pref-${t.code}`}
              onChange={(v) => void savePref(t, { enabled: v })}
              label={<>{t.label}{t.urgent && <span className="chip chip--warn" style={{ marginLeft: 8 }}>urgent</span>}</>}
              hint={t.description}
            />
            {on && <ParamsEditor type={t.code} params={(prefOf(t)?.params ?? {}) as Record<string, unknown>} disabled={!master}
              onSave={(p) => savePref(t, { params: p })} />}
          </div>
        );
      })}
    </div>
  );

  return (
    <main className="page" style={{ maxWidth: 820 }}>
      <p className="breadcrumb"><Link to="/compte">Mon compte</Link> › Notifications</p>
      <h1 className="page-title">Notifications</h1>

      <section className="card">
        <div className="spread">
          <h2 className="card__title card__title--lg">Cet appareil</h2>
          {thisDevice ? <span className="chip chip--ok">activées</span> : <span className="chip">désactivées</span>}
        </div>
        {support === 'ios-install' && (
          <p className="notice notice--warn">Sur iPhone et iPad, installez d’abord Castor Tracker sur l’écran d’accueil (Partager › Sur l’écran d’accueil), puis ouvrez-le depuis son icône pour activer les notifications.</p>
        )}
        {support === 'unsupported' && <p className="notice notice--warn">Ce navigateur ne gère pas les notifications Web Push.</p>}
        {support === 'denied' && (
          <p className="notice notice--warn">Les notifications sont bloquées pour ce site : autorisez-les dans les réglages du navigateur, puis rechargez la page.</p>
        )}
        {support === 'ok' && (
          <div className="inline">
            {thisDevice ? (
              <>
                <button type="button" className="btn" disabled={busy !== null} onClick={() => void test()}>Envoyer une notification de test</button>
                <button type="button" className="btn btn--danger" disabled={busy !== null} onClick={() => void turnOff()}>Désactiver sur cet appareil</button>
              </>
            ) : (
              <button type="button" className="btn btn--primary" disabled={busy !== null} onClick={() => void turnOn()}>
                {busy === 'device' ? 'Activation…' : 'Activer les notifications sur cet appareil'}
              </button>
            )}
          </div>
        )}
        <p className="xsmall muted">
          Les notifications passent par le service push du navigateur (Google, Mozilla ou Apple), chiffrées de bout en bout.
          {!isStandalone() && support === 'ok' ? ' Elles arrivent même navigateur fermé, tant que le système le permet.' : ''}
        </p>
      </section>

      {message && <p className={`notice ${message.ok ? 'notice--ok' : 'notice--error'}`} role="status">{message.text}</p>}

      <section className="card">
        <h2 className="card__title card__title--lg">Réglages généraux</h2>
        <div className="pref-list">
          <div className="pref-row">
            <Switch checked={master} disabled={busy === 'settings'} onChange={(v) => void saveSettings({ enabled: v })}
              label="Toutes les notifications" hint="Coupe ou rétablit d’un coup toutes vos notifications, sur tous vos appareils et le webhook. Vos choix ci-dessous sont conservés." />
          </div>
          <div className="pref-row">
            <Switch checked={s.quiet_hours} disabled={!master || busy === 'settings'} onChange={(v) => void saveSettings({ quiet_hours: v })}
              label="Heures calmes (21 h – 8 h)" hint="Les notifications de la nuit arrivent à 8 h. Les alertes urgentes des administrateurs passent quand même." />
          </div>
        </div>
      </section>

      <section className="card" aria-label="Notifications Castor">
        <div className="spread">
          <h2 className="card__title card__title--lg">Prix Castor</h2>
          {!master && <span className="chip">coupées</span>}
        </div>
        {typeList(userTypes)}
      </section>

      {isAdminRole && adminTypes.length > 0 && (
        <section className="card" aria-label="Notifications d’administration">
          <div className="spread">
            <h2 className="card__title card__title--lg">Administration</h2>
            {!master && <span className="chip">coupées</span>}
          </div>
          {typeList(adminTypes)}
        </section>
      )}

      {isAdminRole && <WebhookCard settings={s} canEdit={Boolean(access?.is_admin)} onSaved={() => qc.invalidateQueries({ queryKey: ['notif'] })} userId={userId} />}

      <section className="card">
        <h2 className="card__title card__title--lg">Mes appareils</h2>
        {(devices.data ?? []).length === 0 && <p className="small muted">Aucun appareil abonné.</p>}
        {(devices.data ?? []).map((d) => (
          <div key={d.id} className="spread">
            <span className="small">
              {d.user_agent ?? 'Appareil'}{d.endpoint === endpoint ? ' · cet appareil' : ''}
              <span className="xsmall muted" style={{ display: 'block' }}>
                ajouté le {stampShort(d.created_at)}
                {d.last_success_at ? ` · dernier envoi ${stampShort(d.last_success_at)}` : ''}
                {d.last_error ? ` · erreur : ${d.last_error}` : ''}
              </span>
            </span>
            <button type="button" className="btn btn--small btn--danger" disabled={busy !== null}
              onClick={() => void act('device', async () => { unwrap(await supabase.from('push_subscriptions').delete().eq('id', d.id)); })}>
              Retirer
            </button>
          </div>
        ))}
      </section>

      <section className="card">
        <h2 className="card__title card__title--lg">Dernières notifications</h2>
        {(recent.data ?? []).length === 0 && <p className="small muted">Rien pour l’instant.</p>}
        {(recent.data ?? []).map((n) => (
          <div key={n.id} className="notif-item">
            <div className="spread">
              <strong className="small">{n.title}</strong>
              <span className="xsmall muted mono">{stampShort(n.created_at)}{n.pending ? ' · en attente' : n.delivered ? '' : ' · non remise'}</span>
            </div>
            <p className="small muted" style={{ margin: 0 }}>{n.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}

const FORMATS: [string, string, string][] = [
  ['json', 'JSON générique', 'Home Assistant, n8n, Node-RED… : POST JSON (type, title, body, url, urgent, data).'],
  ['ntfy', 'ntfy', 'URL du sujet, ex. https://ntfy.sh/castor-x7k2 ; jeton éventuel dans l’en-tête (« Bearer tk_… »).'],
  ['discord', 'Discord', 'URL du webhook du salon (Paramètres du salon › Intégrations).'],
  ['slack', 'Slack et compatibles', 'Slack, Mattermost, Rocket.Chat, Google Chat : message texte.'],
];

function WebhookCard({ settings, canEdit, onSaved, userId }: {
  settings: Settings;
  canEdit: boolean;
  onSaved: () => unknown;
  userId: string;
}) {
  const [draft, setDraft] = useState({ url: '', format: 'json', secret: '', enabled: false });
  const [msg, setMsg] = useState<Message>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setDraft({
      url: settings.webhook_url ?? '',
      format: settings.webhook_format ?? 'json',
      secret: settings.webhook_secret ?? '',
      enabled: Boolean(settings.webhook_enabled),
    });
  }, [settings.webhook_url, settings.webhook_format, settings.webhook_secret, settings.webhook_enabled]);

  async function save(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setMsg(null);
    const res = await supabase.from('notification_settings').upsert({
      user_id: userId,
      webhook_url: draft.url.trim() || null,
      webhook_format: draft.format,
      webhook_secret: draft.secret.trim() || null,
      webhook_enabled: draft.enabled && Boolean(draft.url.trim()),
    }, { onConflict: 'user_id' });
    setBusy(false);
    setMsg(res.error ? { ok: false, text: res.error.message } : { ok: true, text: 'Webhook enregistré.' });
    onSaved();
  }

  async function test() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await runJob('webhook-test', { url: draft.url.trim(), format: draft.format, secret: draft.secret.trim() });
      setMsg({ ok: res.ok !== false, text: res.message ?? '' });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const hint = FORMATS.find((f) => f[0] === draft.format)?.[2];
  return (
    <section className="card">
      <h2 className="card__title card__title--lg">Webhook (administrateurs)</h2>
      <p className="small muted" style={{ margin: 0 }}>
        En plus du push, toutes vos notifications activées partent vers cette adresse : pratique pour Home Assistant, ntfy ou un salon d’équipe.
      </p>
      {!canEdit && <p className="notice notice--warn">Validez le second facteur (TOTP) pour modifier le webhook.</p>}
      <form onSubmit={save} className="pref-list">
        <div className="grid-fields">
          <label className="field">Format
            <select value={draft.format} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, format: e.target.value })}>
              {FORMATS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="field" style={{ gridColumn: 'span 2' }}>URL
            <input type="url" className="mono" placeholder="https://…" disabled={!canEdit} value={draft.url}
              onChange={(e) => setDraft({ ...draft, url: e.target.value })} />
          </label>
        </div>
        {hint && <p className="xsmall muted" style={{ margin: 0 }}>{hint}</p>}
        <label className="field">En-tête Authorization (facultatif)
          <input type="password" autoComplete="off" className="mono" placeholder="Bearer …" disabled={!canEdit} value={draft.secret}
            onChange={(e) => setDraft({ ...draft, secret: e.target.value })} />
        </label>
        <Switch checked={draft.enabled} disabled={!canEdit || !draft.url.trim()} onChange={(v) => setDraft({ ...draft, enabled: v })}
          label="Webhook actif" />
        <div className="inline">
          <button type="submit" className="btn btn--primary" disabled={!canEdit || busy}>Enregistrer</button>
          <button type="button" className="btn" disabled={!canEdit || busy || !draft.url.trim()} onClick={() => void test()}>Tester</button>
        </div>
      </form>
      {msg && <p className={`notice ${msg.ok ? 'notice--ok' : 'notice--error'}`} role="status">{msg.text}</p>}
    </section>
  );
}
