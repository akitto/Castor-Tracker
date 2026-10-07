import { dateLong, dateRange } from '../lib/format';
import type { DashboardRow } from '../lib/supabase';

interface Item {
  date: string;
  label: string;
  when: string;
  kind?: 'key' | 'today';
}

/** EF-05 : ouverture, CA, fermeture des versements, annonce, quadrimestre suivant. */
export default function TimelineCard({ dash }: { dash: DashboardRow }) {
  const today = dash.today ?? '';
  const items: Item[] = [];
  if (dash.current_start) items.push({ date: dash.current_start, when: dateLong(dash.current_start, false), label: `Ouverture ${dash.current_code}` });
  items.push({ date: today, when: dateLong(today, false), label: 'Aujourd’hui', kind: 'today' });
  if (dash.board_date) {
    items.push({ date: dash.board_date, when: dateLong(dash.board_date, false), label: `CA fixant le prix ${dash.next_code}`, kind: 'key' });
  } else if (dash.board_slot_start && dash.board_slot_end) {
    items.push({ date: dash.board_slot_start, when: dateRange(dash.board_slot_start, dash.board_slot_end).replace(/ \d{4}$/, ''), label: `CA fixant le prix ${dash.next_code}`, kind: 'key' });
  }
  if (dash.current_payment_close) {
    items.push({ date: dash.current_payment_close, when: dateLong(dash.current_payment_close, false), label: `Fermeture des versements ${dash.current_code}` });
    items.push({ date: dash.current_payment_close + 'z', when: 'après', label: `Annonce du prix ${dash.next_code}`, kind: 'key' });
  }
  if (dash.next_start) items.push({ date: dash.next_start, when: dateLong(dash.next_start, false), label: `Ouverture ${dash.next_code}` });
  items.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.kind === 'today' ? -1 : 1));

  return (
    <section className="card" aria-labelledby="chrono-title">
      <h2 id="chrono-title" className="card__title">Chronologie</h2>
      <ol className="timeline">
        {items.map((it, i) => (
          <li key={i} className={it.kind === 'today' ? 'today' : it.date < today ? 'past' : it.kind === 'key' ? 'key' : undefined}>
            <span className="mono small muted">{it.when}</span>
            <span className="dot" aria-hidden="true" />
            <span style={{ fontWeight: it.kind ? 600 : 400 }}>{it.label}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
