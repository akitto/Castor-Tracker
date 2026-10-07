import { paymentStatus } from '@castor/core';
import { lazy, Suspense } from 'react';
import { Link } from 'react-router-dom';
import BoardCard from '../components/BoardCard';
import EstimateCard from '../components/EstimateCard';
import GainsCard from '../components/GainsCard';
import { Loading } from '../components/Guards';
import QuoteCard from '../components/QuoteCard';
import Simulator from '../components/Simulator';
import TimelineCard from '../components/TimelineCard';
import { useAuth } from '../lib/auth';
import {
  detailsOf,
  toEstimateParams,
  useActiveParams,
  useCalendar,
  useDashboard,
  useDividendList,
  useEstimateHistory,
  useHistory,
  usePriceSeries,
} from '../lib/data';
import { dateLong, euro } from '../lib/format';
import type { DashboardRow } from '../lib/supabase';
import { useNarrow } from '../lib/useNarrow';

// ECharts n'est chargé que pour les graphiques (chunk séparé).
const PriceChart = lazy(() => import('../components/PriceChart'));
const ConvergenceChart = lazy(() => import('../components/ConvergenceChart'));

export function PaymentLine({ dash }: { dash: DashboardRow }) {
  if (!dash.current_code || !dash.current_start || !dash.current_end || !dash.current_payment_close || !dash.today) return null;
  const s = paymentStatus({ start: dash.current_start, end: dash.current_end, paymentClose: dash.current_payment_close }, dash.today);
  if (s.status === 'open') {
    return (
      <p className="muted" style={{ fontSize: 14 }}>
        Versements {dash.current_code} ouverts jusqu’au <strong style={{ color: 'var(--text)' }}>{dateLong(dash.current_payment_close, false)}</strong> · J−{s.daysToClose}
      </p>
    );
  }
  if (s.status === 'closed') {
    return (
      <p className="muted" style={{ fontSize: 14 }}>
        Versements {dash.current_code} fermés depuis le {dateLong(dash.current_payment_close, false)} · annonce du prix {dash.next_code} attendue
      </p>
    );
  }
  return null;
}

export function Disclaimer() {
  return (
    <footer className="footer-note">
      <p>
        Estimation non officielle, calculée à partir de cours publics et de la formule des avis VINCI : 95 % de la moyenne
        des premiers cours cotés des 20 séances précédant le CA. Ce n’est pas un conseil en investissement.
      </p>
      <nav aria-label="Liens de pied de page" className="inline" style={{ gap: '4px 16px' }}>
        <Link to="/methode">Méthode de calcul</Link>
        <Link to="/historique">Sources des prix</Link>
      </nav>
    </footer>
  );
}

export default function Dashboard() {
  const { access } = useAuth();
  const dash = useDashboard();
  const history = useHistory();
  const series = usePriceSeries();
  const params = useActiveParams();
  const calendar = useCalendar();
  const dividends = useDividendList();
  const conv = useEstimateHistory(dash.data?.next_code);
  const narrow = useNarrow();

  if (dash.isLoading) return <Loading />;
  if (dash.error) return <main className="page"><p className="notice notice--error">Données indisponibles : {(dash.error as Error).message}</p></main>;
  const d = dash.data;
  if (!d) return <main className="page"><p className="muted">Aucune donnée.</p></main>;
  const p = toEstimateParams(params.data);
  const details = detailsOf(d);
  const sessions = series.data ?? [];
  const official = (history.data ?? []).find((h) => h.code === d.next_code)?.official_price ?? null;

  return (
    <main className="page">
      <div className="page-head">
        <div className="page-head__titles">
          <p className="eyebrow">
            Quadrimestre en cours · {d.current_code ?? '—'}{d.current_price !== null ? ` · ${euro(Number(d.current_price))}` : ''}
          </p>
          <h1 className="page-title">Prix Castor du prochain quadrimestre</h1>
        </div>
        <PaymentLine dash={d} />
      </div>

      <div className="row">
        <div className="col-main">
          <EstimateCard dash={d} params={p} />
        </div>
        <div className="col-side">
          <BoardCard dash={d} details={details} isAdmin={access?.role === 'admin'} windowDays={p.windowDays} />
          {narrow && <TimelineCard dash={d} />}
          <QuoteCard dash={d} sessions={sessions} />
        </div>
      </div>

      {!narrow && sessions.length > 0 && (
        <Suspense fallback={<Loading text="Chargement du graphique…" />}>
          <PriceChart sessions={sessions} history={history.data ?? []} dash={d} calendar={calendar} params={p} />
        </Suspense>
      )}

      <div className="row" style={{ alignItems: 'flex-start' }}>
        {!narrow && (
          <div className="col-main">
            <GainsCard dash={d} history={history.data ?? []} />
            <TimelineCard dash={d} />
          </div>
        )}
        <div className="col-side">
          {sessions.length > 0 && (
            <Simulator dash={d} details={details} sessions={sessions} calendar={calendar} dividends={dividends} params={p} />
          )}
        </div>
      </div>

      {!narrow && d.next_code && (conv.data?.length ?? 0) > 1 && (
        <Suspense fallback={null}>
          <ConvergenceChart code={d.next_code} rows={conv.data ?? []} official={official === null ? null : Number(official)} />
        </Suspense>
      )}
      <Disclaimer />
    </main>
  );
}
