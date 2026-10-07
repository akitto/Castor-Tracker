import { useMemo } from 'react';
import { euro } from '../lib/format';
import type { EstimateHistoryRow } from '../lib/supabase';
import { alpha, useThemeColors } from '../lib/theme';
import EChart, { type ChartOption } from './EChart';

/** EF-14 : convergence de l'estimation, jour après jour jusqu'à l'annonce. */
export default function ConvergenceChart({ code, rows, official }: { code: string; rows: EstimateHistoryRow[]; official: number | null }) {
  const c = useThemeColors();
  const option = useMemo<ChartOption>(() => {
    const days = rows.map((r) => r.day as string);
    const p05 = rows.map((r) => Number(r.p05));
    const width = rows.map((r) => Number(r.p95) - Number(r.p05));
    return {
      animation: false,
      textStyle: { fontFamily: 'IBM Plex Sans, system-ui, sans-serif', color: c.muted },
      grid: { left: 56, right: 16, top: 16, bottom: 32 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: c.surface,
        borderColor: c.line,
        textStyle: { color: c.text, fontSize: 13 },
        formatter: (ps: { dataIndex: number }[]) => {
          const r = rows[ps[0]?.dataIndex ?? 0];
          return r ? `${r.day}<br/>Estimation : ${euro(Number(r.central))}<br/>Intervalle : ${euro(Number(r.p05))} – ${euro(Number(r.p95))}<br/>IF ${Math.round(Number(r.reliability))} · ${r.known_sessions ?? 0} séances connues` : '';
        },
      },
      xAxis: { type: 'category', data: days, boundaryGap: false, axisLabel: { color: c.muted, formatter: (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}` }, axisLine: { lineStyle: { color: c.faint } } },
      yAxis: { type: 'value', scale: true, splitLine: { lineStyle: { color: c['line-soft'] } }, axisLabel: { color: c.muted, fontFamily: 'IBM Plex Mono', formatter: (v: number) => `${v} €` } },
      series: [
        { type: 'line', data: p05, stack: 'band', lineStyle: { opacity: 0 }, showSymbol: false, silent: true },
        { type: 'line', data: width, stack: 'band', lineStyle: { opacity: 0 }, areaStyle: { color: alpha(c.accent, 0.16) }, showSymbol: false, silent: true },
        {
          name: 'Estimation',
          type: 'line',
          data: rows.map((r) => Number(r.central)),
          showSymbol: rows.length < 40,
          lineStyle: { width: 2, color: c.accent },
          itemStyle: { color: c.accent },
          markLine: official
            ? { symbol: 'none', lineStyle: { color: c['warn-bar'], width: 1.5 }, label: { formatter: `prix officiel ${euro(official)}`, color: c.warn }, data: [{ yAxis: official }] }
            : undefined,
        },
      ],
    };
  }, [c, rows, official]);

  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return (
    <section className="card" aria-labelledby="conv-title">
      <div className="spread">
        <h2 id="conv-title" className="card__title card__title--lg">Convergence de l’estimation {code}</h2>
        <span className="small muted">{rows.length} jour{rows.length > 1 ? 's' : ''} d’historique</span>
      </div>
      <EChart
        option={option}
        className="chart chart--small"
        label={`Évolution de l’estimation ${code} sur ${rows.length} jours, dernière valeur ${euro(Number(last.central))}.`}
      />
    </section>
  );
}
