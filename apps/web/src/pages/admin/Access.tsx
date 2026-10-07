import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../../lib/auth';
import { stampShort } from '../../lib/format';
import { runJob, supabase, unwrap, type AppConfigRow } from '../../lib/supabase';
import { JobNotice, Panel, useRunJob } from './common';

interface UserItem {
  id: string;
  email: string;
  role: 'admin' | 'viewer' | null;
  created_at: string;
  last_sign_in_at: string | null;
  confirmed: boolean;
  mfa: boolean;
}

/** EF-47 : invitations, rôles et mode de visibilité. */
export default function Access() {
  const { session } = useAuth();
  const qc = useQueryClient();
  const job = useRunJob();
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: async () => (await runJob('users')).users as UserItem[],
  });
  const config = useQuery({ queryKey: ['admin', 'config'], queryFn: async () => unwrap(await supabase.from('app_config').select('*').maybeSingle()) });
  const [invite, setInvite] = useState({ email: '', role: 'viewer', sendEmail: true });
  const [link, setLink] = useState<string | null>(null);
  const [settings, setSettings] = useState<Partial<AppConfigRow>>({});
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    if (config.data) setSettings(config.data);
  }, [config.data]);

  async function sendInvite(e: FormEvent) {
    e.preventDefault();
    setLink(null);
    const res = await job.run('invite', invite);
    if (res?.link) setLink(String(res.link));
    if (res) setInvite({ ...invite, email: '' });
    await users.refetch();
  }

  async function setRole(userId: string, role: string | null) {
    await job.run('set-role', { userId, role });
    await users.refetch();
  }

  async function removeUser(u: UserItem) {
    if (!window.confirm(`Supprimer le compte ${u.email} ?`)) return;
    await job.run('delete-user', { userId: u.id });
    await users.refetch();
  }

  async function saveSettings(e: FormEvent) {
    e.preventDefault();
    setMessage(null);
    const res = await supabase.from('app_config').update({
      visibility: settings.visibility,
      admin_mfa_required: settings.admin_mfa_required,
      site_url: settings.site_url || null,
      alert_spread_bps: settings.alert_spread_bps,
      euronext_history_url: settings.euronext_history_url || null,
    }).eq('id', true);
    setMessage(res.error ? { ok: false, text: res.error.message } : { ok: true, text: 'Réglages enregistrés.' });
    await qc.invalidateQueries();
  }

  return (
    <>
      <h1 className="page-title">Accès</h1>
      <Panel title="Comptes">
        {users.error && <p className="notice notice--error">{(users.error as Error).message}</p>}
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Adresse</th><th>Rôle</th><th>Dernière connexion</th><th>TOTP</th><th /></tr></thead>
            <tbody>
              {(users.data ?? []).map((u) => (
                <tr key={u.id}>
                  <th scope="row" style={{ fontWeight: 500 }}>{u.email}{!u.confirmed && <span className="chip" style={{ marginLeft: 6 }}>invitation en attente</span>}</th>
                  <td>
                    {u.id === session?.user.id ? (
                      <span>{u.role} (vous)</span>
                    ) : (
                      <select value={u.role ?? ''} onChange={(e) => void setRole(u.id, e.target.value || null)} aria-label={`Rôle de ${u.email}`}>
                        <option value="">aucun accès</option>
                        <option value="viewer">lecteur</option>
                        <option value="admin">administrateur</option>
                      </select>
                    )}
                  </td>
                  <td className="mono small">{u.last_sign_in_at ? stampShort(u.last_sign_in_at) : 'jamais'}</td>
                  <td>{u.mfa ? 'oui' : 'non'}</td>
                  <td>{u.id !== session?.user.id && <button type="button" className="btn btn--small btn--danger" onClick={() => void removeUser(u)}>Supprimer</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form onSubmit={sendInvite} className="grid-fields" style={{ alignItems: 'end' }}>
          <label className="field">Inviter une adresse<input type="email" required value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} /></label>
          <label className="field">Rôle
            <select value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
              <option value="viewer">lecteur</option><option value="admin">administrateur</option>
            </select>
          </label>
          <label className="check"><input type="checkbox" checked={invite.sendEmail} onChange={(e) => setInvite({ ...invite, sendEmail: e.target.checked })} />Envoyer l’e-mail (SMTP requis)</label>
          <button type="submit" className="btn btn--primary" disabled={job.busy !== null}>Inviter</button>
        </form>
        {link && (
          <div className="notice notice--ok">
            Lien d’invitation à transmettre (usage unique) :
            <div className="inline" style={{ marginTop: 6 }}>
              <input readOnly value={link} className="mono" style={{ flex: 1, minWidth: 0 }} onFocus={(e) => e.target.select()} />
              <button type="button" className="btn btn--small" onClick={() => void navigator.clipboard.writeText(link)}>Copier</button>
            </div>
          </div>
        )}
        <JobNotice result={job.result} error={job.error} />
      </Panel>

      <form onSubmit={saveSettings}>
        <Panel title="Visibilité et sécurité">
          <div role="radiogroup" aria-label="Visibilité" className="stack">
            {[
              ['restricted', 'Restreinte', 'comptes invités uniquement (lien magique ou mot de passe), pages non indexées'],
              ['public', 'Publique en lecture seule', 'consultation sans compte ; le back-office reste réservé'],
              ['private', 'Privée', 'administrateurs uniquement'],
            ].map(([value, label, help]) => (
              <label key={value} className="check" style={{ alignItems: 'flex-start' }}>
                <input type="radio" name="visibility" checked={settings.visibility === value} onChange={() => setSettings({ ...settings, visibility: value })} />
                <span><strong>{label}</strong> — <span className="muted small">{help}</span></span>
              </label>
            ))}
          </div>
          <label className="check"><input type="checkbox" checked={Boolean(settings.admin_mfa_required)} onChange={(e) => setSettings({ ...settings, admin_mfa_required: e.target.checked })} />TOTP obligatoire pour l’administration</label>
          <div className="grid-fields">
            <label className="field">Adresse du site (redirection des invitations)<input type="url" placeholder="https://castor.exemple.fr" value={settings.site_url ?? ''} onChange={(e) => setSettings({ ...settings, site_url: e.target.value })} /></label>
            <label className="field">Seuil d’alerte entre sources (%)<input type="number" min={0.01} step={0.01} value={(settings.alert_spread_bps ?? 50) / 100} onChange={(e) => setSettings({ ...settings, alert_spread_bps: Math.round(Number(e.target.value) * 100) })} /></label>
          </div>
          <label className="field">Modèle d’URL de l’historique Euronext (avancé)
            <input className="mono" placeholder="https://live.euronext.com/…/{code}?…&startdate={from}&enddate={to}" value={settings.euronext_history_url ?? ''} onChange={(e) => setSettings({ ...settings, euronext_history_url: e.target.value })} />
          </label>
          <button type="submit" className="btn btn--primary" style={{ alignSelf: 'flex-start' }}>Enregistrer</button>
          {message && <p className={`notice ${message.ok ? 'notice--ok' : 'notice--error'}`}>{message.text}</p>}
        </Panel>
      </form>
    </>
  );
}
