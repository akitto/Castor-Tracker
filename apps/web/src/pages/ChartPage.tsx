import ConvergenceChart from '../components/ConvergenceChart';
import GainsCard from '../components/GainsCard';
import { Loading } from '../components/Guards';
import PriceChart from '../components/PriceChart';
import { toEstimateParams, useActiveParams, useCalendar, useDashboard, useEstimateHistory, useHistory, usePriceSeries } from '../lib/data';
import { useNarrow } from '../lib/useNarrow';
import { Disclaimer } from './Dashboard';

/** Écran « Graphique » (mobile) : cours et prix Castor, plus-values, convergence. */
export default function ChartPage() {
  const dash = useDashboard();
  const history = useHistory();
  const series = usePriceSeries();
  const params = useActiveParams();
  const calendar = useCalendar();
  const narrow = useNarrow();
  const conv = useEstimateHistory(dash.data?.next_code);
  if (dash.isLoading || series.isLoading) return <Loading />;
  const d = dash.data;
  if (!d) return <main className="page"><p className="muted">Aucune donnée.</p></main>;
  const official = (history.data ?? []).find((h) => h.code === d.next_code)?.official_price ?? null;
  return (
    <main className="page">
      <h1 className="page-title">Cours et prix Castor</h1>
      {(series.data?.length ?? 0) > 0 && (
        <PriceChart sessions={series.data ?? []} history={history.data ?? []} dash={d} calendar={calendar} params={toEstimateParams(params.data)} compact={narrow} />
      )}
      <GainsCard dash={d} history={history.data ?? []} />
      {d.next_code && (conv.data?.length ?? 0) > 1 && (
        <ConvergenceChart code={d.next_code} rows={conv.data ?? []} official={official === null ? null : Number(official)} />
      )}
      <Disclaimer />
    </main>
  );
}
