import { euronextHolidays } from '@castor/core';
import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useClosures, useDashboard, useDividends } from '../../lib/data';
import { amount, dateFr } from '../../lib/format';
import { supabase } from '../../lib/supabase';
import { Panel } from './common';

/** EF-44 : dividendes et jours fériés, saisie et contrôle. */
export default function Reference() {
  const qc = useQueryClient();
  const dividends = useDividends();
  const holidays = useClosures();
  const dash = useDashboard();
  const [div, setDiv] = useState({ ex_date: '', amount: '', kind: 'acompte', pay_date: '', source: '' });
  const [hol, setHol] = useState({ day: '', label: '', half_day: false });
  const [error, setError] = useState<string | null>(null);
  const year = Number((dash.data?.today ?? new Date().toISOString()).slice(0, 4));
  const existing = new Set((holidays.data ?? []).map((h) => h.day));
  const missingStandard = [year, year + 1].flatMap((y) => euronextHolidays(y)).filter((h) => !existing.has(h.date));

  async function exec(p: PromiseLike<{ error: { message: string } | null }>) {
    setError(null);
    const { error: e } = await p;
    if (e) setError(e.message);
    await qc.invalidateQueries();
    return !e;
  }

  async function addDividend(e: FormEvent) {
    e.preventDefault();
    const ok = await exec(
      supabase.from('dividends').upsert({
        ex_date: div.ex_date,
        amount: Number(div.amount.replace(',', '.')),
        kind: div.kind,
        pay_date: div.pay_date || null,
        source: div.source || null,
      }),
    );
    if (ok) setDiv({ ex_date: '', amount: '', kind: 'acompte', pay_date: '', source: '' });
  }

  async function addHoliday(e: FormEvent) {
    e.preventDefault();
    const ok = await exec(supabase.from('market_holidays').upsert({ day: hol.day, label: hol.label, half_day: hol.half_day, source: 'manuel' }));
    if (ok) setHol({ day: '', label: '', half_day: false });
  }

  const recentHolidays = (holidays.data ?? []).filter((h) => Number(h.day.slice(0, 4)) >= year - 1);

  return (
    <>
      <h1 className="page-title">Dividendes et jours fériés</h1>
      {error && <p className="notice notice--error">{error}</p>}
      <Panel title="Détachements de dividende">
        <p className="small muted">
          La projection retire chaque dividende des cours à partir de sa date de détachement. Les détachements passés
          sont aussi récupérés auprès de Yahoo lors des collectes.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Détachement</th><th className="num">Montant</th><th>Type</th><th>Paiement</th><th>Source</th><th /></tr></thead>
            <tbody>
              {[...(dividends.data ?? [])].reverse().map((d) => (
                <tr key={d.ex_date}>
                  <th scope="row" className="mono">{dateFr(d.ex_date)}</th>
                  <td className="num">{amount(Number(d.amount))} €</td>
                  <td>{d.kind}</td>
                  <td className="mono">{dateFr(d.pay_date)}</td>
                  <td className="small">{d.source ?? '—'}{d.note ? ` · ${d.note}` : ''}</td>
                  <td><button type="button" className="btn btn--small btn--danger" onClick={() => void exec(supabase.from('dividends').delete().eq('ex_date', d.ex_date))}>Supprimer</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form onSubmit={addDividend} className="grid-fields" style={{ alignItems: 'end' }}>
          <label className="field">Détachement<input type="date" required value={div.ex_date} onChange={(e) => setDiv({ ...div, ex_date: e.target.value })} /></label>
          <label className="field">Montant (€)<input className="mono" inputMode="decimal" required value={div.amount} onChange={(e) => setDiv({ ...div, amount: e.target.value })} /></label>
          <label className="field">Type
            <select value={div.kind} onChange={(e) => setDiv({ ...div, kind: e.target.value })}>
              <option value="acompte">Acompte</option><option value="solde">Solde</option><option value="exceptionnel">Exceptionnel</option>
            </select>
          </label>
          <label className="field">Paiement<input type="date" value={div.pay_date} onChange={(e) => setDiv({ ...div, pay_date: e.target.value })} /></label>
          <label className="field">Source<input value={div.source} onChange={(e) => setDiv({ ...div, source: e.target.value })} /></label>
          <button type="submit" className="btn btn--primary">Ajouter</button>
        </form>
      </Panel>

      <Panel title="Jours fériés et séances courtes">
        {missingStandard.length > 0 && (
          <div className="notice notice--warn">
            Fermetures standard absentes de la table : {missingStandard.map((h) => `${dateFr(h.date)} (${h.label})`).join(', ')}.{' '}
            <button type="button" className="btn btn--small" onClick={() => void exec(supabase.from('market_holidays').upsert(missingStandard.map((h) => ({ day: h.date, label: h.label, half_day: false, source: 'standard' }))))}>
              Les ajouter
            </button>
          </div>
        )}
        <p className="small muted">
          Le calendrier calcule déjà les fermetures standard (1er janvier, Vendredi saint, lundi de Pâques, 1er mai, 25 et
          26 décembre). Saisir ici toute fermeture exceptionnelle annoncée par Euronext. Les séances courtes restent des séances.
        </p>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Jour</th><th>Libellé</th><th>Type</th><th /></tr></thead>
            <tbody>
              {recentHolidays.map((h) => (
                <tr key={h.day}>
                  <th scope="row" className="mono">{dateFr(h.day)}</th>
                  <td>{h.label}</td>
                  <td>{h.half_day ? 'séance courte' : 'fermé'}</td>
                  <td><button type="button" className="btn btn--small btn--danger" onClick={() => void exec(supabase.from('market_holidays').delete().eq('day', h.day))}>Supprimer</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <form onSubmit={addHoliday} className="grid-fields" style={{ alignItems: 'end' }}>
          <label className="field">Jour<input type="date" required value={hol.day} onChange={(e) => setHol({ ...hol, day: e.target.value })} /></label>
          <label className="field">Libellé<input required value={hol.label} onChange={(e) => setHol({ ...hol, label: e.target.value })} /></label>
          <label className="check"><input type="checkbox" checked={hol.half_day} onChange={(e) => setHol({ ...hol, half_day: e.target.checked })} />Séance courte (marché ouvert)</label>
          <button type="submit" className="btn btn--primary">Ajouter</button>
        </form>
      </Panel>
    </>
  );
}
