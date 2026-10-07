import { useEffect, useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';

interface FactorState {
  id: string;
  verified: boolean;
  qr?: string;
  secret?: string;
}

/** Second facteur (TOTP) : inscription avec QR code, ou vérification d'un facteur existant. */
export default function MfaSetup({ onDone }: { onDone?: () => void }) {
  const { refreshAccess } = useAuth();
  const [factor, setFactor] = useState<FactorState | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data, error: e } = await supabase.auth.mfa.listFactors();
      if (e) return setError(e.message);
      const verified = data.totp[0];
      if (verified) {
        if (!cancelled) setFactor({ id: verified.id, verified: true });
        return;
      }
      for (const f of data.all) {
        if (f.factor_type === 'totp' && f.status !== 'verified') await supabase.auth.mfa.unenroll({ factorId: f.id });
      }
      const enrolled = await supabase.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Castor Tracker ${new Date().toISOString().slice(0, 10)}` });
      if (enrolled.error) return setError(enrolled.error.message);
      if (!cancelled) setFactor({ id: enrolled.data.id, verified: false, qr: enrolled.data.totp.qr_code, secret: enrolled.data.totp.secret });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!factor) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId: factor.id, code: code.trim() });
    setBusy(false);
    if (err) return setError(err.message === 'Invalid TOTP code entered' ? 'Code incorrect ou expiré.' : err.message);
    await refreshAccess();
    onDone?.();
  }

  return (
    <section className="card" style={{ maxWidth: 520 }} aria-labelledby="mfa-title">
      <h2 id="mfa-title" className="card__title card__title--lg">Second facteur d’authentification</h2>
      {!factor && !error && <p className="muted">Préparation…</p>}
      {factor && !factor.verified && (
        <>
          <p className="small">
            L’administration exige un code à usage unique (TOTP). Scannez ce QR code avec une application d’authentification
            (Aegis, 2FAS, Google Authenticator, Bitwarden…), puis saisissez le code affiché.
          </p>
          {factor.qr && <img className="qr" src={factor.qr} alt="QR code d’inscription TOTP" />}
          {factor.secret && <p className="xsmall muted">Clé manuelle : <span className="mono">{factor.secret}</span></p>}
        </>
      )}
      {factor?.verified && <p className="small">Saisissez le code à 6 chiffres de votre application d’authentification.</p>}
      {factor && (
        <form onSubmit={submit} className="inline" style={{ alignItems: 'flex-end' }}>
          <label className="field">
            Code
            <input className="mono" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6}
              value={code} onChange={(e) => setCode(e.target.value)} required style={{ width: 140 }} />
          </label>
          <button type="submit" className="btn btn--primary" disabled={busy || code.length !== 6}>Valider</button>
        </form>
      )}
      {error && <p className="notice notice--error">{error}</p>}
    </section>
  );
}
