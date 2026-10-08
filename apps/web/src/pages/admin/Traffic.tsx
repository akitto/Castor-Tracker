import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import EChart, { type ChartOption } from '../../components/EChart';
import { supabase, unwrap } from '../../lib/supabase';
import { useThemeColors } from '../../lib/theme';
import { Panel } from './common';

/** [heure de Paris « AAAA-MM-JJTHH:00 », affichages, visiteurs uniques de l'heure] */
type HourRow = [string, number, number];
interface TrafficData {
  hours: HourRow[];
  views: number;
  visitors: number;
}

const PERIODS: [string, number][] = [
  ['24 h', 24],
  ['7 jours', 24 * 7],
  ['30 jours', 24 * 30],
];

const int = new Intl.NumberFormat('fr-FR');
const dayFmt = new Intl.DateTimeFormat('fr-FR', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
const dayOf = (key: string) => dayFmt.format(new Date(`${key.slice(0, 10)}T00:00:00Z`));
const hourOf = (key: string) => Number(key.slice(11, 13));
const plural = (n: number, word: string) => `${int.format(n)} ${word}${n > 1 ? 's' : ''}`;

/** Fréquentation de la PWA heure par heure (pages affichées, hors back-office). */
export default function Traffic() {
  const c = useThemeColors();
  const [hours, setHours] = useState(24);
  const [profile, setProfile] = useState(false);
  const query = useQuery({
    queryKey: ['admin', 'traffic', hours],
    refetchInterval: 5 * 60_000,
    queryFn: async () => unwrap(await supabase.rpc('admin_page_views_hourly', { p_hours: hours })) as unknown as TrafficData,
  });
  const data = query.data;

  // Vue chronologique, ou cumul par heure de la journée (0 h à 23 h) sur la période.
  const bars = useMemo(() => {
    const rows = data?.hours ?? [];
    if (!profile) return rows.map(([key, views, visitors]) => ({ key, views, visitors: visitors as number | null }));
    const sums = Array.from({ length: 24 }, (_, h) => ({ key: `${h}`, views: 0, visitors: null as number | null }));
    for (const [key, views] of rows) sums[hourOf(key)].views += views;
    return sums;
  }, [data, profile]);

  const peak = useMemo(() => {
    const rows = data?.hours ?? [];
    return rows.reduce<HourRow | null>((best, r) => (r[1] > 0 && (!best || r[1] > best[1]) ? r : best), null);
  }, [data]);

  const option = useMemo<ChartOption>(() => {
    const long = !profile && hours > 24;
    const label = (key: string) => {
      if (profile) return `${key} h`;
      return long ? dayOf(key) : `${hourOf(key)} h`;
    };
    return {
      animation: false,
      textStyle: { fontFamily: 'IBM Plex Sans, system-ui, sans-serif', color: c.muted },
      grid: { left: 48, right: 16, top: 16, bottom: 36 },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow', shadowStyle: { color: c['line-soft'], opacity: 0.6 } },
        backgroundColor: c.surface,
        borderColor: c.line,
        textStyle: { color: c.text, fontSize: 13 },
        formatter: (params: { dataIndex: number }[]) => {
          const b = bars[params[0]?.dataIndex ?? -1];
          if (!b) return '';
          const title = profile
            ? `De ${b.key} h à ${(Number(b.key) + 1) % 24} h, cumul sur ${hours / 24} jour${hours > 24 ? 's' : ''}`
            : `${dayOf(b.key)}, de ${hourOf(b.key)} h à ${(hourOf(b.key) + 1) % 24} h`;
          const visitors = b.visitors === null ? '' : `<br/>${plural(b.visitors, 'visiteur')}`;
          return `<strong>${title}</strong><br/>${plural(b.views, 'page')} affichée${b.views > 1 ? 's' : ''}${visitors}`;
        },
      },
      xAxis: {
        type: 'category',
        data: bars.map((b) => b.key),
        axisLine: { lineStyle: { color: c.faint } },
        axisTick: { show: false },
        axisLabel: {
          color: c.muted,
          formatter: label,
          // une étiquette par jour (à minuit) en vue longue, toutes les 3 h sinon
          interval: (i: number, key: string) => (long ? hourOf(key) === 0 : profile ? i % 3 === 0 : hourOf(key) % 3 === 0),
        },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        splitLine: { lineStyle: { color: c['line-soft'] } },
        axisLabel: { color: c.muted, fontFamily: 'IBM Plex Mono' },
      },
      series: [
        {
          name: 'Pages affichées',
          type: 'bar',
          data: bars.map((b) => b.views),
          barCategoryGap: long ? '10%' : '25%',
          itemStyle: { color: c.accent, borderRadius: [4, 4, 0, 0] },
          emphasis: { itemStyle: { color: c['accent-strong'] } },
        },
      ],
    };
  }, [bars, c, hours, profile]);

  const periodLabel = PERIODS.find(([, h]) => h === hours)?.[0] ?? `${hours} h`;
  const chartLabel = data
    ? `Pages affichées ${profile ? 'par heure de la journée' : 'heure par heure'} sur ${periodLabel} : ${plural(data.views, 'page')}, ${plural(data.visitors, 'visiteur')} unique${data.visitors > 1 ? 's' : ''}.`
    : 'Fréquentation';

  return (
    <>
      <h1 className="page-title">Fréquentation</h1>
      <Panel
        title="Pages affichées par heure"
        actions={
          <>
            <div className="segmented" role="group" aria-label="Période">
              {PERIODS.map(([l, h]) => (
                <button key={h} type="button" aria-pressed={hours === h} onClick={() => setHours(h)}>{l}</button>
              ))}
            </div>
            <div className="segmented" role="group" aria-label="Vue">
              <button type="button" aria-pressed={!profile} onClick={() => setProfile(false)}>Chronologique</button>
              <button type="button" aria-pressed={profile} onClick={() => setProfile(true)}>Par heure de la journée</button>
            </div>
          </>
        }
      >
        {query.error && <p className="notice notice--error" role="alert">{(query.error as Error).message}</p>}
        {data && (
          <div className="stats" style={{ borderTop: 0, paddingTop: 0 }}>
            <div className="stat"><span className="small muted">Pages affichées ({periodLabel})</span><span className="stat-value">{int.format(data.views)}</span></div>
            <div className="stat"><span className="small muted">Visiteurs uniques</span><span className="stat-value">{int.format(data.visitors)}</span></div>
            <div className="stat">
              <span className="small muted">Heure la plus chargée</span>
              <span className="stat-value">{peak ? `${hourOf(peak[0])} h` : '—'}</span>
              {peak && <span className="xsmall muted">{dayOf(peak[0])} · {plural(peak[1], 'page')}</span>}
            </div>
          </div>
        )}
        {data && data.views === 0 ? (
          <p className="muted">Aucune page affichée sur la période. Le comptage démarre avec le déploiement de cette version.</p>
        ) : (
          data && <EChart option={option} label={chartLabel} />
        )}
        {query.isLoading && <p className="loading">Chargement…</p>}
        <p className="xsmall muted">
          Heures de Paris. Une visite = une page affichée dans l’application (pages d’administration exclues, rechargement de la même page
          sous 10 s ignoré). Visiteur = navigateur, reconnu par un identifiant aléatoire sans donnée personnelle ; en vue « par heure de la
          journée », les visiteurs ne sont pas cumulables et ne sont pas affichés. Données conservées 13 mois.
        </p>
      </Panel>
    </>
  );
}
