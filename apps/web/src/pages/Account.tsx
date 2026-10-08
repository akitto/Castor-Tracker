import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import MfaSetup from '../components/Mfa';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface FactorInfo {
  id: string;
  friendly_name?: string;
  status: string;
  created_at: string;
}

export default function Account() {
  const { session, access, signOut, refreshAccess } = useAuth();
  const [factors, setFactors] = useState<FactorInfo[]>([]);
  const [enrolling, setEnrolling] = useState(false);
  const [password, setPassword] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function loadFactors() {
    const { data } = await supabase.auth.mfa.listFactors();
    setFactors((data?.totp ?? []) as FactorInfo[]);
  }
  useEffect(() => {
    void loadFactors();
  }, []);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password });
    setMessage(error ? { ok: false, text: error.message } : { ok: true, text: 'Mot de passe enregistré.' });
    if (!error) setPassword('');
  }

  async function removeFactor(id: string) {
    const { error } = await supabase.auth.mfa.unenroll({ factorId: id });
    setMessage(error ? { ok: false, text: error.message } : { ok: true, text: 'Facteur supprimé.' });
    await loadFactors();
    await supabase.auth.refreshSession();
    await refreshAccess();
  }

  return (
    <main className="page" style={{ maxWidth: 820 }}>
      <h1 className="page-title">Mon compte</h1>
      <section className="card">
        <dl className="facts">
          <dt>Adresse</dt><dd>{session?.user.email}</dd>
          <dt>Rôle</dt><dd>{access?.role === 'admin' ? 'administrateur' : access?.role === 'viewer' ? 'lecteur' : 'aucun'}</dd>
          <dt>Niveau de session</dt><dd>{access?.aal === 'aal2' ? 'second facteur validé' : 'mot de passe ou lien'}</dd>
        </dl>
      </section>
      {access?.role && (
        <section className="card">
          <div className="spread">
            <h2 className="card__title card__title--lg">Notifications</h2>
            <Link to="/compte/notifications" className="btn btn--small">Gérer</Link>
          </div>
          <p className="small muted" style={{ margin: 0 }}>
            Web Push sur vos appareils{access.role === 'admin' ? ' et webhook' : ''} : estimation, date du CA, prix officiel, alertes de cours…
            Chaque notification s’active ou se coupe séparément.
          </p>
        </section>
      )}
      <section className="card">
        <h2 className="card__title card__title--lg">Second facteur (TOTP)</h2>
        {factors.length === 0 && !enrolling && (
          <p className="small muted">Aucun facteur enregistré.{access?.role === 'admin' ? ' Obligatoire pour l’administration.' : ''}</p>
        )}
        {factors.map((f) => (
          <div key={f.id} className="spread">
            <span>{f.friendly_name ?? 'Application TOTP'} · ajouté le {new Date(f.created_at).toLocaleDateString('fr-FR')}</span>
            <button type="button" className="btn btn--small btn--danger" onClick={() => void removeFactor(f.id)}>Supprimer</button>
          </div>
        ))}
        {enrolling ? (
          <MfaSetup onDone={() => { setEnrolling(false); void loadFactors(); }} />
        ) : (
          factors.length === 0 && <button type="button" className="btn" onClick={() => setEnrolling(true)}>Configurer une application TOTP</button>
        )}
      </section>
      <section className="card">
        <h2 className="card__title card__title--lg">Mot de passe</h2>
        <form onSubmit={changePassword} className="inline" style={{ alignItems: 'flex-end' }}>
          <label className="field">Nouveau mot de passe
            <input type="password" autoComplete="new-password" minLength={10} required value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <button type="submit" className="btn btn--primary">Enregistrer</button>
        </form>
        <p className="xsmall muted">10 caractères minimum. Facultatif si vous vous connectez par lien magique.</p>
      </section>
      {message && <p className={`notice ${message.ok ? 'notice--ok' : 'notice--error'}`}>{message.text}</p>}
      <button type="button" className="btn" style={{ alignSelf: 'flex-start' }} onClick={() => void signOut()}>Se déconnecter</button>
    </main>
  );
}
