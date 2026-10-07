import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Loading } from '../components/Guards';
import MfaSetup from '../components/Mfa';
import { useAuth } from '../lib/auth';
import { CONFIGURED } from '../lib/config';
import { supabase } from '../lib/supabase';

export default function Login() {
  const { session, access, accessLoading, needsMfa } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [mode, setMode] = useState<'link' | 'password'>('link');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  useEffect(() => {
    if (session && access && !needsMfa) navigate(from, { replace: true });
  }, [session, access, needsMfa, from, navigate]);

  if (!CONFIGURED) return <main className="page"><p className="notice notice--warn">Configuration absente (voir le README).</p></main>;
  if (session && accessLoading) return <Loading />;
  if (session && needsMfa) {
    return (
      <main className="page" style={{ alignItems: 'center' }}>
        <MfaSetup onDone={() => navigate(from, { replace: true })} />
      </main>
    );
  }

  async function sendLink(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: false, emailRedirectTo: window.location.origin },
    });
    setBusy(false);
    if (err) return setError(err.message.includes('Signups not allowed') ? 'Adresse inconnue : l’accès se fait sur invitation.' : err.message);
    setSent(true);
  }

  async function verifyCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
    setBusy(false);
    if (err) setError('Code incorrect ou expiré.');
  }

  async function signInPassword(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) setError(err.message === 'Invalid login credentials' ? 'Identifiants incorrects.' : err.message);
  }

  async function resetPassword() {
    if (!email.trim()) return setError('Saisissez d’abord votre adresse e-mail.');
    const { error: err } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: `${window.location.origin}/compte` });
    if (err) setError(err.message);
    else setInfo('Si l’adresse existe, un lien de réinitialisation vient d’être envoyé.');
  }

  return (
    <main className="page" style={{ maxWidth: 520 }}>
      <div className="page-head__titles">
        <p className="eyebrow">Castor Tracker</p>
        <h1 className="page-title">Connexion</h1>
        <p className="muted small">Accès sur invitation. Aucune inscription libre.</p>
      </div>
      <section className="card">
        <div className="segmented" role="group" aria-label="Méthode de connexion">
          <button type="button" aria-pressed={mode === 'link'} onClick={() => setMode('link')}>Lien magique</button>
          <button type="button" aria-pressed={mode === 'password'} onClick={() => setMode('password')}>Mot de passe</button>
        </div>
        {mode === 'link' && !sent && (
          <form onSubmit={sendLink} className="stack-lg">
            <label className="field">Adresse e-mail
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <button type="submit" className="btn btn--primary" disabled={busy}>Recevoir un lien de connexion</button>
          </form>
        )}
        {mode === 'link' && sent && (
          <form onSubmit={verifyCode} className="stack-lg">
            <p className="notice notice--ok">
              Lien envoyé à {email}. Ouvrez-le sur cet appareil, ou saisissez le code à 6 chiffres reçu dans le même
              e-mail (utile dans l’application installée).
            </p>
            <label className="field">Code reçu
              <input className="mono" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} />
            </label>
            <div className="inline">
              <button type="submit" className="btn btn--primary" disabled={busy || code.length < 6}>Valider le code</button>
              <button type="button" className="btn" onClick={() => setSent(false)}>Changer d’adresse</button>
            </div>
          </form>
        )}
        {mode === 'password' && (
          <form onSubmit={signInPassword} className="stack-lg">
            <label className="field">Adresse e-mail
              <input type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
            <label className="field">Mot de passe
              <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </label>
            <div className="inline">
              <button type="submit" className="btn btn--primary" disabled={busy}>Se connecter</button>
              <button type="button" className="btn" onClick={() => void resetPassword()}>Mot de passe oublié</button>
            </div>
          </form>
        )}
        {error && <p className="notice notice--error" role="alert">{error}</p>}
        {info && <p className="notice notice--ok" role="status">{info}</p>}
      </section>
    </main>
  );
}
