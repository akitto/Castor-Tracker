import { addDays, compareQuad, rollingTheoretical, type EstimateParams, type ISODate, type Session, type TradingCalendar } from '@castor/core';
import { useMemo, useState } from 'react';
import { amount, dateFr, euro } from '../lib/format';
import type { DashboardRow, HistoryRow } from '../lib/supabase';
import { alpha, useThemeColors } from '../lib/theme';
import EChart, { type ChartOption } from './EChart';

const PERIODS: [string, number | null][] = [
  ['3 M', 3],
  ['6 M', 6],
  ['1 an', 12],
  ['3 ans', 36],
  ['5 ans', 60],
  ['Tout', null],
];

function monthsBefore(date: ISODate, n: number): ISODate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - n);
  return d.toISOString().slice(0, 10);
}

const monthFmt = new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' });
const monthYearFmt = new Intl.DateTimeFormat('fr-FR', { month: 'short', year: 'numeric', timeZone: 'UTC' });

/** EF-10 à EF-12 : cours VINCI, escalier des prix Castor, estimation N+1 et sa bande, fenêtre du CA. */
export default function PriceChart({ sessions, history, dash, calendar, params, compact = false }: {
  sessions: Session[];
  history: HistoryRow[];
  dash: DashboardRow;
  calendar: TradingCalendar;
  params: EstimateParams;
  compact?: boolean;
}) {
  const c = useThemeColors();
  const [period, setPeriod] = useState<number | null>(compact ? 6 : 12);
  const [showClose, setShowClose] = useState(false);
  const [showTheo, setShowTheo] = useState(false);
  const field = showClose ? 'close' : 'open';
  const today = dash.today ?? sessions[sessions.length - 1]?.date ?? '';
  const start = period ? monthsBefore(today, period) : sessions[0]?.date ?? today;
  const end = dash.next_end && dash.next_end > today ? dash.next_end : addDays(today, 30);

  const priceData = useMemo(
    () => sessions.filter((s) => typeof s[field] === 'number').map((s) => [s.date, s[field] as number]),
    [sessions, field],
  );
  const theoData = useMemo(() => {
    if (!showTheo) return [];
    return rollingTheoretical(sessions, calendar, { ...params, priceField: params.priceField }, monthsBefore(start, 1)).map((p) => [p.date, p.price]);
  }, [showTheo, sessions, calendar, params, start]);

  const option = useMemo<ChartOption>(() => {
    const official = history
      .filter((h) => h.official_price !== null && h.code && h.start_date && h.end_date)
      .sort((a, b) => compareQuad(a.code as string, b.code as string));
    const steps: ([string, number] | [string, null])[] = [];
    const labels: { coord: [string, number]; value: string }[] = [];
    official.forEach((h, i) => {
      const p = Number(h.official_price);
      const prev = official[i - 1];
      if (prev && addDays(prev.end_date as string, 1) !== h.start_date) steps.push([h.start_date as string, null]);
      steps.push([h.start_date as string, p], [h.end_date as string, p]);
      if ((h.end_date as string) >= start) labels.push({ coord: [(h.start_date as string) < start ? start : (h.start_date as string), p], value: `${h.code} · ${amount(p)} €` });
    });
    const est = dash.next_start && dash.next_end && dash.central !== null;
    const series: object[] = [
      {
        name: `Cours VINCI (${showClose ? 'clôture' : 'ouverture'})`,
        type: 'line',
        data: priceData,
        showSymbol: false,
        sampling: 'lttb',
        lineStyle: { width: 1.5, color: c.price },
        itemStyle: { color: c.price },
        z: 3,
        markArea: dash.window_start && dash.window_end
          ? {
              silent: true,
              itemStyle: { color: alpha(c.accent, 0.1) },
              label: { show: !compact, position: 'insideBottomLeft', color: c['accent-strong'], fontSize: 11, fontWeight: 600 },
              data: [[{ name: dash.board_date ? 'Fenêtre' : 'Fenêtres possibles', xAxis: dash.window_start }, { xAxis: dash.window_end }]],
            }
          : undefined,
        markLine: {
          silent: true,
          symbol: 'none',
          lineStyle: { color: c.muted, type: 'dashed', width: 1 },
          label: { formatter: 'aujourd’hui', color: c['accent-strong'], fontSize: 11 },
          data: [{ xAxis: today }],
        },
      },
      {
        name: 'Prix Castor officiel',
        type: 'line',
        data: steps,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 2.5, color: c.accent },
        itemStyle: { color: c.accent },
        z: 4,
        markPoint: compact
          ? undefined
          : {
              symbol: 'circle',
              symbolSize: 0,
              label: { show: true, position: 'top', align: 'left', color: c['accent-strong'], fontSize: 12, fontWeight: 600, formatter: (p: { value: string }) => p.value },
              data: labels,
            },
      },
    ];
    if (est) {
      series.push({
        name: `Estimation ${dash.next_code} (intervalle à 90 %)`,
        type: 'line',
        data: [[dash.next_start, Number(dash.central)], [dash.next_end, Number(dash.central)]],
        showSymbol: false,
        lineStyle: { width: 2.5, type: 'dashed', color: c.accent },
        itemStyle: { color: c.accent },
        z: 4,
        markArea: dash.p05 !== null && dash.p95 !== null
          ? {
              silent: true,
              itemStyle: { color: alpha(c.accent, 0.14) },
              data: [[{ xAxis: dash.next_start, yAxis: Number(dash.p05) }, { xAxis: dash.next_end, yAxis: Number(dash.p95) }]],
            }
          : undefined,
        markPoint: {
          symbol: 'circle',
          symbolSize: 0,
          label: { show: !compact, position: 'bottom', align: 'left', color: c['accent-strong'], fontSize: 12, fontWeight: 600, fontFamily: 'IBM Plex Mono', formatter: `${dash.next_code} : ${amount(Number(dash.central))} €` },
          data: [{ coord: [dash.next_start, Number(dash.p05 ?? dash.central)] }],
        },
      });
    }
    if (showTheo) {
      series.push({
        name: 'Prix théorique glissant (CA le jour même)',
        type: 'line',
        data: theoData,
        showSymbol: false,
        lineStyle: { width: 1.2, color: c['warn-bar'] },
        itemStyle: { color: c['warn-bar'] },
        z: 2,
      });
    }
    return {
      animation: false,
      textStyle: { fontFamily: 'IBM Plex Sans, system-ui, sans-serif', color: c.muted },
      grid: { left: 56, right: compact ? 12 : 24, top: 28, bottom: 36 },
      tooltip: {
        trigger: 'axis',
        backgroundColor: c.surface,
        borderColor: c.line,
        textStyle: { color: c.text, fontSize: 13 },
        valueFormatter: (v: unknown) => (typeof v === 'number' ? euro(v) : '—'),
        axisPointer: { type: 'line', lineStyle: { color: c.faint } },
      },
      xAxis: {
        type: 'time',
        axisLine: { lineStyle: { color: c.faint } },
        splitLine: { show: false },
        axisLabel: {
          color: c.muted,
          hideOverlap: true,
          formatter: (value: number) => {
            const d = new Date(value);
            return d.getUTCMonth() === 0 ? monthYearFmt.format(d) : monthFmt.format(d);
          },
        },
      },
      yAxis: {
        type: 'value',
        scale: true,
        splitLine: { lineStyle: { color: c['line-soft'] } },
        axisLabel: { color: c.muted, fontFamily: 'IBM Plex Mono', formatter: (v: number) => `${v} €` },
      },
      // La fenêtre de zoom filtre les données : l'axe des prix s'ajuste à la période affichée.
      dataZoom: [{ type: 'inside', xAxisIndex: 0, filterMode: 'filter', startValue: start, endValue: end }],
      series,
    };
  }, [c, priceData, theoData, history, dash, start, end, today, showClose, showTheo, compact]);

  const visible = sessions.filter((s) => s.date >= start);
  const lo = Math.min(...visible.map((s) => s[field] ?? Infinity));
  const hi = Math.max(...visible.map((s) => s[field] ?? -Infinity));
  const label = `Cours VINCI du ${dateFr(start)} à aujourd’hui (entre ${euro(lo)} et ${euro(hi)}), prix Castor officiels de chaque quadrimestre${
    dash.central !== null ? ` et estimation ${dash.next_code} à ${euro(Number(dash.central))}, intervalle à 90 % de ${euro(Number(dash.p05))} à ${euro(Number(dash.p95))}` : ''
  }.`;

  return (
    <section className="card" aria-labelledby="chart-title" style={{ gap: 16, padding: compact ? 16 : '24px 28px' }}>
      <div className="spread" style={{ gap: '12px 24px' }}>
        <h2 id="chart-title" className="card__title card__title--lg">Cours VINCI et prix Castor</h2>
        <div className="inline" style={{ gap: '12px 20px' }}>
          <div className="segmented" role="group" aria-label="Période">
            {PERIODS.filter(([, m]) => !compact || m !== 60).map(([l, m]) => (
              <button key={l} type="button" aria-pressed={period === m} onClick={() => setPeriod(m)}>{l}</button>
            ))}
          </div>
          {!compact && (
            <>
              <label className="check small muted"><input type="checkbox" checked={showTheo} onChange={(e) => setShowTheo(e.target.checked)} />Prix théorique glissant</label>
              <label className="check small muted"><input type="checkbox" checked={showClose} onChange={(e) => setShowClose(e.target.checked)} />Clôture</label>
            </>
          )}
        </div>
      </div>
      <EChart option={option} label={label} />
      <ul className="chart-legend">
        <li><svg width="24" height="10" aria-hidden="true"><path d="M1 7 L8 3 L15 6 L23 2" fill="none" stroke="var(--price)" strokeWidth="1.5" /></svg>Cours VINCI ({showClose ? 'clôture' : 'ouverture'})</li>
        <li><svg width="24" height="10" aria-hidden="true"><path d="M1 8 H12 V2 H23" fill="none" stroke="var(--accent)" strokeWidth="2.5" /></svg>Prix Castor officiel</li>
        {dash.central !== null && <li><svg width="24" height="10" aria-hidden="true"><rect x="0" y="0" width="24" height="10" fill="var(--accent)" fillOpacity="0.14" /><path d="M0 5 H24" stroke="var(--accent)" strokeWidth="2.5" strokeDasharray="5 3" /></svg>Estimation {dash.next_code} et intervalle à 90 %</li>}
        {dash.window_start && <li><span style={{ display: 'inline-block', width: 24, height: 10, background: 'var(--accent)', opacity: 0.16 }} />{dash.board_date ? 'Fenêtre de 20 séances' : 'Fenêtres de 20 séances possibles (créneau du CA)'}</li>}
        {showTheo && <li><svg width="24" height="10" aria-hidden="true"><path d="M1 6 H23" stroke="var(--warn-bar)" strokeWidth="1.5" /></svg>Prix théorique glissant</li>}
      </ul>
    </section>
  );
}
