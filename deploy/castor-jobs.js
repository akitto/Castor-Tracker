// Castor Tracker — fonction castor-jobs en un seul fichier, pour Supabase Cloud.
// Tableau de bord Supabase › Edge Functions › Deploy a new function › Via Editor :
//   nom de la fonction : castor-jobs ; remplacer tout le contenu de index.ts par ce fichier ; Deploy function.
// Puis, dans les réglages de la fonction, désactiver la vérification JWT (« Verify JWT ») :
// la fonction contrôle elle-même ses appels (secret des tâches planifiées, session admin + TOTP).
// Fichier généré par scripts/build-cloud-bundle.mjs à partir de supabase/functions/castor-jobs : ne pas modifier.
// supabase/functions/_shared/core/dates.ts
var DAY_MS = 864e5;
var ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
function isISODate(value) {
  if (!ISO_RE.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toISOString().slice(0, 10) === value;
}
function toDayNumber(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}
function fromDayNumber(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}
function addDays(date, days) {
  return fromDayNumber(toDayNumber(date) + days);
}
function weekday(date) {
  return new Date(toDayNumber(date) * DAY_MS).getUTCDay();
}
function isWeekend(date) {
  const w = weekday(date);
  return w === 0 || w === 6;
}
var parisFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Paris",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23"
});
function parisClock(now = /* @__PURE__ */ new Date()) {
  const parts = parisFormatter.formatToParts(now);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute"))
  };
}
function parisDateOf(epochMs) {
  return parisClock(new Date(epochMs)).date;
}

// supabase/functions/_shared/core/calendar.ts
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
function euronextHolidays(year) {
  const easter = easterSunday(year);
  return [
    {
      date: `${year}-01-01`,
      label: "Jour de l'an"
    },
    {
      date: addDays(easter, -2),
      label: "Vendredi saint"
    },
    {
      date: addDays(easter, 1),
      label: "Lundi de P\xE2ques"
    },
    {
      date: `${year}-05-01`,
      label: "F\xEAte du travail"
    },
    {
      date: `${year}-12-25`,
      label: "No\xEBl"
    },
    {
      date: `${year}-12-26`,
      label: "Lendemain de No\xEBl"
    }
  ];
}
var TradingCalendar = class {
  extra;
  byYear = /* @__PURE__ */ new Map();
  constructor(extraClosures = []) {
    this.extra = new Set(extraClosures);
  }
  isHoliday(date) {
    if (this.extra.has(date)) return true;
    const year = Number(date.slice(0, 4));
    let set = this.byYear.get(year);
    if (!set) {
      set = new Set(euronextHolidays(year).map((h) => h.date));
      this.byYear.set(year, set);
    }
    return set.has(date);
  }
  isTradingDay(date) {
    return !isWeekend(date) && !this.isHoliday(date);
  }
  previousSession(date) {
    let d = addDays(date, -1);
    while (!this.isTradingDay(d)) d = addDays(d, -1);
    return d;
  }
  nextSession(date) {
    let d = addDays(date, 1);
    while (!this.isTradingDay(d)) d = addDays(d, 1);
    return d;
  }
  /**
   * Les `n` séances qui précèdent `date`, dans l'ordre chronologique.
   * `inclusive` : la séance de `date` elle-même compte si c'en est une.
   */
  sessionsBefore(date, n, inclusive = false) {
    if (n <= 0) return [];
    const out = [];
    let d = inclusive ? date : addDays(date, -1);
    while (out.length < n) {
      if (this.isTradingDay(d)) out.push(d);
      d = addDays(d, -1);
    }
    return out.reverse();
  }
  /** Séances entre deux dates, bornes incluses. */
  sessionsBetween(from, to) {
    const out = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (this.isTradingDay(d)) out.push(d);
    }
    return out;
  }
};

// supabase/functions/_shared/core/fixed.ts
var PRICE_SCALE = 1e4;
function toUnits(value) {
  if (!Number.isFinite(value)) throw new Error(`cours invalide : ${value}`);
  return BigInt(Math.round(value * PRICE_SCALE));
}
function divRound(num2, den, mode) {
  if (den <= 0n) throw new Error("diviseur nul ou n\xE9gatif");
  if (num2 < 0n) throw new Error("num\xE9rateur n\xE9gatif");
  const q = num2 / den;
  const r = num2 % den;
  if (r === 0n) return q;
  if (mode === "down") return q;
  if (mode === "up") return q + 1n;
  return 2n * r >= den ? q + 1n : q;
}
function roundCents(value, mode = "nearest") {
  const cents = value * 100;
  if (mode === "down") return Math.floor(cents + 1e-7) / 100;
  if (mode === "up") return Math.ceil(cents - 1e-7) / 100;
  return Math.round(cents + 1e-9) / 100;
}

// supabase/functions/_shared/core/formula.ts
var DEFAULT_FORMULA = {
  windowDays: 20,
  discountBps: 500,
  rounding: "nearest",
  excludeBoardDay: true,
  priceField: "open"
};
function fieldValue(session, field) {
  if (!session) return null;
  const v = session[field];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}
function indexSessions(sessions) {
  return new Map(sessions.map((s) => [
    s.date,
    s
  ]));
}
function windowSessions(calendar, boardDate, params) {
  return calendar.sessionsBefore(boardDate, params.windowDays, !params.excludeBoardDay);
}
function subscriptionPrice(values, params) {
  if (values.length === 0) throw new Error("fen\xEAtre vide");
  let sum = 0n;
  for (const v of values) sum += toUnits(v);
  const num2 = BigInt(1e4 - params.discountBps) * sum;
  const den = 1000000n * BigInt(values.length);
  return Number(divRound(num2, den, params.rounding)) / 100;
}
function evaluateWindow(sessions, calendar, boardDate, params) {
  const dates = windowSessions(calendar, boardDate, params);
  const values = dates.map((d) => fieldValue(sessions.get(d), params.priceField));
  const missing = dates.filter((_, i) => values[i] === null);
  const price = missing.length === 0 ? subscriptionPrice(values, params) : null;
  return {
    dates,
    values,
    missing,
    price
  };
}

// supabase/functions/_shared/core/random.ts
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function normal(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function randomSeed() {
  return Math.floor(Math.random() * 2 ** 31);
}

// supabase/functions/_shared/core/estimate.ts
var DEFAULT_ESTIMATE = {
  ...DEFAULT_FORMULA,
  toleranceBps: 100,
  nSims: 1e4,
  bootstrapDays: 250,
  modelSigmaBps: 0
};
var FALLBACK_DAILY_SIGMA = 0.013;
var MIN_RETURNS = 20;
var MAX_ABS_RETURN = 0.25;
function candidateDates(calendar, board) {
  if (board.mode === "date") return [
    {
      date: board.date,
      weight: 1
    }
  ];
  if (board.end < board.start) throw new Error(`cr\xE9neau invalide : ${board.start} \u2192 ${board.end}`);
  let days = calendar.sessionsBetween(board.start, board.end);
  if (days.length === 0) days = [
    board.start
  ];
  const weights = board.weights && Object.keys(board.weights).length > 0 ? board.weights : null;
  let list = days.map((date) => ({
    date,
    weight: weights ? Math.max(0, Number(weights[date] ?? 0)) || 0 : 1
  }));
  let total = list.reduce((s, c) => s + c.weight, 0);
  if (!(total > 0)) {
    list = days.map((date) => ({
      date,
      weight: 1
    }));
    total = list.length;
  }
  return list.filter((c) => c.weight > 0).map((c) => ({
    date: c.date,
    weight: c.weight / total
  }));
}
function mostProbable(candidates) {
  if (candidates.length === 0) throw new Error("aucune date candidate");
  const max = Math.max(...candidates.map((c) => c.weight));
  const top = candidates.filter((c) => Math.abs(c.weight - max) < 1e-12);
  return top[Math.floor((top.length - 1) / 2)];
}
function dailyReturns(sessions, field, asOf, maxDays, dividends = []) {
  const points = [];
  for (const s of sessions) {
    if (s.date > asOf) continue;
    const v = fieldValue(s, field);
    if (v !== null) points.push({
      date: s.date,
      v
    });
  }
  points.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
  const slice = points.slice(-(Math.max(1, maxDays) + 1));
  const raw = [];
  let outliers = 0;
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1];
    const cur = slice[i];
    let div = 0;
    for (const d of dividends) if (d.exDate > prev.date && d.exDate <= cur.date) div += d.amount;
    const r = Math.log((cur.v + div) / prev.v);
    if (!Number.isFinite(r) || Math.abs(r) > MAX_ABS_RETURN) {
      outliers++;
      continue;
    }
    raw.push(r);
  }
  if (raw.length === 0) return {
    returns: [],
    outliers
  };
  const mean = raw.reduce((s, r) => s + r, 0) / raw.length;
  return {
    returns: raw.map((r) => r - mean),
    outliers
  };
}
function standardDeviation(values) {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += values[i];
  mean /= n;
  let ss = 0;
  for (let i = 0; i < n; i++) ss += (values[i] - mean) ** 2;
  return Math.sqrt(ss / (n - 1));
}
function quantileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0];
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}
function weightedQuantile(values, weights, p) {
  const order = values.map((v, i) => ({
    v,
    w: weights[i]
  })).sort((a, b) => a.v - b.v);
  const total = order.reduce((s, o) => s + o.w, 0);
  let acc = 0;
  for (const o of order) {
    acc += o.w;
    if (acc >= p * total - 1e-12) return o.v;
  }
  return order[order.length - 1].v;
}
function prepare(input) {
  const params = {
    ...DEFAULT_ESTIMATE,
    ...input.params ?? {}
  };
  const calendar = input.calendar ?? new TradingCalendar(input.extraClosures ?? []);
  const warnings = [];
  const byDate = /* @__PURE__ */ new Map();
  for (const s of input.sessions) if (s.date <= input.asOf) byDate.set(s.date, s);
  const asOfValue = fieldValue(byDate.get(input.asOf), params.priceField);
  const pathStart = calendar.isTradingDay(input.asOf) && asOfValue === null ? input.asOf : calendar.nextSession(input.asOf);
  const candidates = candidateDates(calendar, input.board);
  const fills = /* @__PURE__ */ new Set();
  const windows = candidates.map((c) => {
    const dates = windowSessions(calendar, c.date, params);
    let lastKnown = null;
    const values = dates.map((d) => {
      if (d >= pathStart) return null;
      const v = fieldValue(byDate.get(d), params.priceField);
      if (v !== null) {
        lastKnown = v;
        return v;
      }
      fills.add(d);
      return lastKnown ?? previousValue(byDate, calendar, d, params.priceField);
    });
    for (let i = values.length - 1; i >= 0; i--) {
      if (dates[i] < pathStart && (values[i] === null || Number.isNaN(values[i]))) {
        values[i] = nextKnownValue(values, i);
      }
    }
    const known = dates.filter((d) => d < pathStart).length;
    return {
      dates,
      values,
      known
    };
  });
  if (fills.size > 0) {
    warnings.push(`s\xE9ances pass\xE9es sans cours, compl\xE9t\xE9es par le cours pr\xE9c\xE9dent : ${[
      ...fills
    ].sort().join(", ")}`);
  }
  for (const w of windows) {
    for (let i = 0; i < w.dates.length; i++) {
      if (w.dates[i] < pathStart && w.values[i] === null) {
        throw new Error(`aucun cours disponible pour la s\xE9ance du ${w.dates[i]}`);
      }
    }
  }
  const maxEnd = windows.reduce((m, w) => w.dates[w.dates.length - 1] > m ? w.dates[w.dates.length - 1] : m, "");
  const path = pathStart <= maxEnd ? calendar.sessionsBetween(pathStart, maxEnd) : [];
  const pathIndex = new Map(path.map((d, i) => [
    d,
    i
  ]));
  const lastPriceDate = input.lastPriceDate ?? input.asOf;
  const dividends = input.dividends ?? [];
  const dividendAt = path.map((d, i) => {
    const prev = i === 0 ? lastPriceDate : path[i - 1];
    let amount = 0;
    for (const div of dividends) {
      if (div.exDate > prev && div.exDate <= d && div.exDate > lastPriceDate) amount += div.amount;
    }
    return amount;
  });
  if (path.length > 0 && !(input.lastPrice > 0)) throw new Error("dernier cours manquant pour la projection");
  return {
    calendar,
    params,
    candidates,
    windows,
    path,
    pathIndex,
    dividendAt,
    lastPrice: input.lastPrice,
    lastPriceDate,
    warnings
  };
}
function previousValue(byDate, calendar, date, field) {
  let d = date;
  for (let i = 0; i < 30; i++) {
    d = calendar.previousSession(d);
    const v = fieldValue(byDate.get(d), field);
    if (v !== null) return v;
  }
  return null;
}
function nextKnownValue(values, index) {
  for (let i = index + 1; i < values.length; i++) if (values[i] !== null) return values[i];
  return null;
}
function windowPrice(prep, w, future) {
  const values = w.dates.map((d, i) => {
    const v = w.values[i];
    if (v !== null) return v;
    return future(prep.pathIndex.get(d));
  });
  return subscriptionPrice(values, prep.params);
}
function centralPath(prep, assumed) {
  let s = assumed;
  return prep.path.map((_, i) => {
    s = Math.max(0.01, s - prep.dividendAt[i]);
    return Math.round(s * 1e4) / 1e4;
  });
}
function estimate(input) {
  const prep = prepare(input);
  const { params, candidates, windows, path } = prep;
  const seed = (input.seed ?? randomSeed()) >>> 0;
  const reference = input.referencePrice ?? null;
  const tolerance = params.toleranceBps / 1e4;
  const warnings = [
    ...prep.warnings
  ];
  const knownCounts = windows.map((w) => w.known);
  const probableIdx = candidates.indexOf(mostProbable(candidates));
  const unionStart = windows.reduce((m, w) => w.dates[0] < m ? w.dates[0] : m, windows[0].dates[0]);
  const unionEnd = windows.reduce((m, w) => w.dates[w.dates.length - 1] > m ? w.dates[w.dates.length - 1] : m, windows[0].dates[windows[0].dates.length - 1]);
  const central0 = centralPath(prep, prep.lastPrice > 0 ? prep.lastPrice : 1);
  const exacts = windows.map((w) => w.values.every((v) => v !== null) ? subscriptionPrice(w.values, params) : null);
  const details = candidates.map((c, i) => ({
    date: c.date,
    weight: c.weight,
    windowStart: windows[i].dates[0],
    windowEnd: windows[i].dates[windows[i].dates.length - 1],
    known: windows[i].known,
    exact: exacts[i],
    projected: exacts[i] ?? windowPrice(prep, windows[i], (k) => central0[k]),
    median: exacts[i]
  }));
  const base = {
    asOf: input.asOf,
    lastPrice: prep.lastPrice,
    lastPriceDate: prep.lastPriceDate,
    seed,
    referencePrice: reference,
    mostProbableDate: candidates[probableIdx].date,
    knownMostProbable: knownCounts[probableIdx],
    knownMin: Math.min(...knownCounts),
    knownMax: Math.max(...knownCounts),
    windowDays: params.windowDays,
    windowUnion: {
      start: unionStart,
      end: unionEnd
    },
    simulatedSessions: path,
    candidates: details,
    params
  };
  const allKnown = exacts.every((p) => p !== null);
  if (allKnown && params.modelSigmaBps <= 0) {
    const values = exacts;
    const weights = candidates.map((c) => c.weight);
    const central2 = weightedQuantile(values, weights, 0.5);
    let within2 = 0;
    let below2 = 0;
    values.forEach((v, i) => {
      if (Math.abs(v - central2) <= tolerance * central2 + 1e-9) within2 += weights[i];
      if (reference !== null && v < reference - 1e-9) below2 += weights[i];
    });
    return {
      ...base,
      nSims: 0,
      state: candidates.length === 1 ? "computed" : "frozen",
      deterministic: candidates.length === 1,
      central: central2,
      p05: weightedQuantile(values, weights, 0.05),
      p25: weightedQuantile(values, weights, 0.25),
      p75: weightedQuantile(values, weights, 0.75),
      p95: weightedQuantile(values, weights, 0.95),
      reliability: round1(within2 * 100),
      probBelow: reference === null ? null : round4(below2),
      returnsUsed: 0,
      sigmaDaily: 0,
      warnings
    };
  }
  const sample = path.length > 0 ? dailyReturns(input.sessions, params.priceField, input.asOf, params.bootstrapDays, input.dividends ?? []) : {
    returns: [],
    outliers: 0
  };
  if (sample.outliers > 0) warnings.push(`${sample.outliers} rendement(s) aberrant(s) \xE9cart\xE9(s) de l'historique`);
  const useBootstrap = sample.returns.length >= MIN_RETURNS;
  if (path.length > 0 && !useBootstrap) {
    warnings.push(`historique trop court (${sample.returns.length} rendements) : loi normale \xE0 \u03C3 = 1,3 % par jour`);
  }
  const returns = sample.returns;
  const sigmaDaily = useBootstrap ? standardDeviation(returns) : path.length > 0 ? FALLBACK_DAILY_SIGMA : 0;
  const nSims = Math.max(100, Math.floor(params.nSims));
  const rand = mulberry32(seed);
  const cumulative = [];
  let acc = 0;
  for (const c of candidates) {
    acc += c.weight;
    cumulative.push(acc);
  }
  const windowNeeds = windows.map((w) => {
    const firstUnknown = w.values.findIndex((v) => v === null);
    if (firstUnknown < 0) return {
      from: -1,
      to: -1,
      knownSum: 0
    };
    let knownSum = 0;
    for (let i = 0; i < firstUnknown; i++) knownSum += w.values[i];
    return {
      from: prep.pathIndex.get(w.dates[firstUnknown]),
      to: prep.pathIndex.get(w.dates[w.dates.length - 1]),
      knownSum
    };
  });
  const factor = (1e4 - params.discountBps) / 1e4;
  const modelSigma = params.modelSigmaBps / 1e4;
  const simPath = new Float64Array(path.length);
  const results = new Float64Array(nSims);
  const perCandidate = candidates.map(() => []);
  for (let s = 0; s < nSims; s++) {
    const u = rand();
    let ci = cumulative.findIndex((c) => u < c);
    if (ci < 0) ci = candidates.length - 1;
    const need = windowNeeds[ci];
    let price;
    if (need.from < 0) {
      price = exacts[ci];
    } else {
      let spot = prep.lastPrice;
      for (let i = 0; i <= need.to; i++) {
        const r = useBootstrap ? returns[Math.floor(rand() * returns.length)] : FALLBACK_DAILY_SIGMA * normal(rand);
        spot = spot * Math.exp(r) - prep.dividendAt[i];
        if (spot < 0.01) spot = 0.01;
        simPath[i] = spot;
      }
      let sum = need.knownSum;
      for (let i = need.from; i <= need.to; i++) sum += simPath[i];
      price = roundCents(factor * sum / params.windowDays, params.rounding);
    }
    if (modelSigma > 0) price = roundCents(price * (1 + modelSigma * normal(rand)), params.rounding);
    results[s] = price;
    perCandidate[ci].push(price);
  }
  const sorted = results.slice().sort();
  const central = roundCents(quantileSorted(sorted, 0.5));
  let within = 0;
  let below = 0;
  for (let i = 0; i < nSims; i++) {
    const v = results[i];
    if (Math.abs(v - central) <= tolerance * central + 1e-9) within++;
    if (reference !== null && v < reference - 1e-9) below++;
  }
  perCandidate.forEach((list, i) => {
    if (list.length > 0) {
      const arr = Float64Array.from(list).sort();
      details[i].median = roundCents(quantileSorted(arr, 0.5));
    }
  });
  const state = allKnown ? candidates.length === 1 ? "computed" : "frozen" : base.knownMax === 0 ? "projection" : "window";
  return {
    ...base,
    nSims,
    state,
    deterministic: false,
    central,
    p05: roundCents(quantileSorted(sorted, 0.05)),
    p25: roundCents(quantileSorted(sorted, 0.25)),
    p75: roundCents(quantileSorted(sorted, 0.75)),
    p95: roundCents(quantileSorted(sorted, 0.95)),
    reliability: round1(within / nSims * 100),
    probBelow: reference === null ? null : round4(below / nSims),
    returnsUsed: useBootstrap ? returns.length : 0,
    sigmaDaily: round6(sigmaDaily),
    warnings
  };
}
function round1(v) {
  return Math.round(v * 10) / 10;
}
function round4(v) {
  return Math.round(v * 1e4) / 1e4;
}
function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

// supabase/functions/_shared/core/backtest.ts
var FIELD_LABEL = {
  open: "ouverture",
  close: "cl\xF4ture",
  vwap: "VWAP"
};
var ROUNDING_LABEL = {
  nearest: "au plus proche",
  up: "sup\xE9rieur",
  down: "inf\xE9rieur"
};
function variantKey(v) {
  return `${v.priceField}/${v.rounding}/${v.excludeBoardDay ? "exclu" : "inclus"}`;
}
function variantLabel(v) {
  return `${FIELD_LABEL[v.priceField]}, centime ${ROUNDING_LABEL[v.rounding]}, jour du CA ${v.excludeBoardDay ? "exclu" : "inclus"}`;
}
function allVariants() {
  const out = [];
  for (const priceField of [
    "open",
    "close",
    "vwap"
  ]) {
    for (const rounding of [
      "nearest",
      "up",
      "down"
    ]) {
      for (const excludeBoardDay of [
        true,
        false
      ]) out.push({
        priceField,
        rounding,
        excludeBoardDay
      });
    }
  }
  return out;
}
var toCents = (v) => Math.round(v * 100);
function runBacktest(input) {
  const calendar = input.calendar ?? new TradingCalendar(input.extraClosures ?? []);
  const sessions = indexSessions(input.sessions);
  const refs = input.references.filter((r) => r.boardDate && r.officialPrice > 0);
  const base = input.base ?? DEFAULT_FORMULA;
  const results = (input.variants ?? allVariants()).map((variant) => {
    const params = {
      ...base,
      ...variant
    };
    const rows = refs.map((ref) => {
      const ev = evaluateWindow(sessions, calendar, ref.boardDate, params);
      const computed = ev.price;
      const diff = computed === null ? null : (toCents(computed) - toCents(ref.officialPrice)) / 100;
      return {
        code: ref.code,
        boardDate: ref.boardDate,
        official: ref.officialPrice,
        computed,
        diff,
        diffPct: diff === null ? null : diff / ref.officialPrice,
        exact: diff === 0,
        missing: ev.missing.length
      };
    });
    const done = rows.filter((r) => r.computed !== null);
    const n = done.length;
    const nExact = done.filter((r) => r.exact).length;
    const abs = done.map((r) => Math.abs(r.diff));
    const rel = done.map((r) => r.computed / r.official - 1);
    return {
      variant,
      key: variantKey(variant),
      label: variantLabel(variant),
      rows,
      n,
      nExact,
      nMissing: rows.length - n,
      exactRate: n > 0 ? nExact / n : 0,
      mae: n > 0 ? round42(abs.reduce((s, v) => s + v, 0) / n) : null,
      maxAbs: n > 0 ? round42(Math.max(...abs)) : null,
      sigmaBps: n > 0 ? round2(Math.sqrt(rel.reduce((s, v) => s + v * v, 0) / n) * 1e4) : null
    };
  });
  results.sort((a, b) => b.exactRate - a.exactRate || b.n - a.n || (a.mae ?? Number.POSITIVE_INFINITY) - (b.mae ?? Number.POSITIVE_INFINITY));
  const best = results.find((r) => r.n > 0) ?? null;
  const exact = results.find((r) => r.n > 0 && r.n === refs.length && r.exactRate === 1) ?? null;
  return {
    references: refs.length,
    variants: results,
    best,
    exact
  };
}
function inferBoardDates(input) {
  const calendar = input.calendar ?? new TradingCalendar(input.extraClosures ?? []);
  const params = input.params ?? DEFAULT_FORMULA;
  const presumed = input.reference.presumedDate ?? input.reference.boardDate;
  if (!presumed) throw new Error(`date pr\xE9sum\xE9e manquante pour ${input.reference.code}`);
  const range = input.rangeSessions ?? 60;
  const before = calendar.sessionsBefore(presumed, range);
  const after = [];
  let d = presumed;
  if (calendar.isTradingDay(presumed)) after.push(presumed);
  while (after.length < range + (calendar.isTradingDay(presumed) ? 1 : 0)) {
    d = calendar.nextSession(d);
    after.push(d);
  }
  const sessions = indexSessions(input.sessions);
  const target = toCents(input.reference.officialPrice);
  const matches = [];
  const scored = [];
  let incomplete = 0;
  for (const date of [
    ...before,
    ...after
  ]) {
    const ev = evaluateWindow(sessions, calendar, date, params);
    if (ev.price === null) {
      incomplete++;
      continue;
    }
    const diff = (toCents(ev.price) - target) / 100;
    if (diff === 0) matches.push({
      date,
      price: ev.price
    });
    scored.push({
      date,
      price: ev.price,
      diff
    });
  }
  scored.sort((a, b) => Math.abs(a.diff) - Math.abs(b.diff) || (a.date < b.date ? -1 : 1));
  return {
    code: input.reference.code,
    officialPrice: input.reference.officialPrice,
    presumedDate: presumed,
    matches,
    closest: scored.slice(0, 5),
    scanned: before.length + after.length,
    incomplete
  };
}
function replayEstimates(input) {
  const calendar = input.calendar ?? new TradingCalendar(input.extraClosures ?? []);
  const params = {
    ...DEFAULT_ESTIMATE,
    ...input.params ?? {},
    nSims: input.nSims ?? 1e3
  };
  const daysBefore = input.daysBefore ?? 60;
  const step = Math.max(1, input.step ?? 1);
  const byDate = indexSessions(input.sessions);
  const tolerance = params.toleranceBps / 1e4;
  const points = [];
  const skipped = [];
  let seed = (input.seed ?? 20261007) >>> 0;
  for (const ref of input.references) {
    if (!ref.boardDate || !(ref.officialPrice > 0)) {
      skipped.push(`${ref.code} : date du CA inconnue`);
      continue;
    }
    const days = calendar.sessionsBefore(ref.boardDate, daysBefore);
    for (let i = 0; i < days.length; i++) {
      const rank = days.length - i;
      if ((rank - 1) % step !== 0) continue;
      const asOf = days[i];
      const s = byDate.get(asOf);
      const last = fieldValue(s, "close") ?? fieldValue(s, params.priceField);
      if (last === null) continue;
      try {
        const r = estimate({
          sessions: input.sessions,
          asOf,
          lastPrice: last,
          board: {
            mode: "date",
            date: ref.boardDate
          },
          params,
          dividends: input.dividends,
          calendar,
          seed: seed++
        });
        const error = r.central - ref.officialPrice;
        points.push({
          code: ref.code,
          asOf,
          sessionsToBoard: rank,
          known: r.knownMostProbable,
          central: r.central,
          p05: r.p05,
          p95: r.p95,
          reliability: r.reliability,
          official: ref.officialPrice,
          covered: ref.officialPrice >= r.p05 - 1e-9 && ref.officialPrice <= r.p95 + 1e-9,
          withinTolerance: Math.abs(error) <= tolerance * r.central + 1e-9,
          error: round42(error)
        });
      } catch (e) {
        skipped.push(`${ref.code} au ${asOf} : ${e.message}`);
      }
    }
  }
  const w = params.windowDays;
  const bucketDefs = [
    [
      "Fen\xEAtre pas commenc\xE9e",
      0,
      0
    ],
    [
      "1 \xE0 5 s\xE9ances connues",
      1,
      5
    ],
    [
      "6 \xE0 10 s\xE9ances connues",
      6,
      10
    ],
    [
      "11 \xE0 15 s\xE9ances connues",
      11,
      15
    ],
    [
      `16 \xE0 ${w - 1} s\xE9ances connues`,
      16,
      w - 1
    ],
    [
      "Fen\xEAtre compl\xE8te",
      w,
      w
    ]
  ];
  const buckets = bucketDefs.map(([label, minKnown, maxKnown]) => {
    const pts = points.filter((p) => p.known >= minKnown && p.known <= maxKnown);
    const n = pts.length;
    return {
      label,
      minKnown,
      maxKnown,
      n,
      coverage: n ? round42(pts.filter((p) => p.covered).length / n) : null,
      hitRate: n ? round42(pts.filter((p) => p.withinTolerance).length / n) : null,
      meanReliability: n ? round2(pts.reduce((s, p) => s + p.reliability, 0) / n) : null
    };
  });
  const uncertain = points.filter((p) => p.known < w);
  return {
    points,
    buckets,
    coverage: uncertain.length ? round42(uncertain.filter((p) => p.covered).length / uncertain.length) : null,
    n: points.length,
    skipped
  };
}
function round2(v) {
  return Math.round(v * 100) / 100;
}
function round42(v) {
  return Math.round(v * 1e4) / 1e4;
}

// supabase/functions/_shared/core/quadrimester.ts
var CODE_RE = /^(\d{4})\/([123])$/;
function parseQuadCode(code) {
  const m = CODE_RE.exec(code);
  if (!m) throw new Error(`code de quadrimestre invalide : ${code}`);
  return {
    year: Number(m[1]),
    index: Number(m[2])
  };
}
function formatQuadCode(year, index) {
  return `${year}/${index}`;
}
function quadrimesterOf(date) {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  return formatQuadCode(year, Math.floor((month - 1) / 4) + 1);
}
var PERIODS = {
  1: {
    start: "01-01",
    end: "04-30",
    close: "04-15"
  },
  2: {
    start: "05-01",
    end: "08-31",
    close: "08-15"
  },
  3: {
    start: "09-01",
    end: "12-31",
    close: "12-15"
  }
};
function quadPeriod(code) {
  const { year, index } = parseQuadCode(code);
  const p = PERIODS[index];
  return {
    code,
    start: `${year}-${p.start}`,
    end: `${year}-${p.end}`,
    paymentClose: `${year}-${p.close}`
  };
}
function nextQuad(code) {
  const { year, index } = parseQuadCode(code);
  return index === 3 ? formatQuadCode(year + 1, 1) : formatQuadCode(year, index + 1);
}
function prevQuad(code) {
  const { year, index } = parseQuadCode(code);
  return index === 1 ? formatQuadCode(year - 1, 3) : formatQuadCode(year, index - 1);
}
function defaultBoardSlot(code) {
  const { year, index } = parseQuadCode(code);
  if (index === 1) return {
    start: `${year - 1}-10-14`,
    end: `${year - 1}-10-23`
  };
  if (index === 2) return {
    start: `${year}-02-01`,
    end: `${year}-02-12`
  };
  return {
    start: `${year}-06-10`,
    end: `${year}-06-26`
  };
}

// supabase/functions/_shared/core/csv.ts
function normalizeHeader(cell) {
  return cell.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/["']/g, "").replace(/\s+/g, " ").trim();
}
function detectDelimiter(lines) {
  const sample = lines.slice(0, 20).join("\n");
  const counts = [
    ";",
    "	",
    ","
  ].map((d) => ({
    d,
    n: sample.split(d).length - 1
  }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ",";
}
function splitCsvLine(line, delimiter) {
  const out = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  out.push(cur.trim());
  return out;
}
function parseDecimal(raw) {
  if (raw === void 0 || raw === null) return null;
  let s = String(raw).replace(/[\s  "€]/g, "");
  if (s === "" || s === "-" || s.toLowerCase() === "null" || s.toLowerCase() === "n/a") return null;
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma >= 0 && lastDot >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  } else if (lastComma >= 0) {
    s = (s.match(/,/g) ?? []).length > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
  }
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
function parseDateCell(raw) {
  if (!raw) return null;
  const s = raw.trim().replace(/"/g, "");
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const d = `${m[1]}-${m[2]}-${m[3]}`;
    return isISODate(d) ? d : null;
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s);
  if (m) {
    const d = `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
    return isISODate(d) ? d : null;
  }
  return null;
}
function priceColumn(h) {
  if (/adj/.test(h)) return null;
  if ([
    "date",
    "jour",
    "seance",
    "trade_date",
    "trade date",
    "date de seance"
  ].includes(h)) return "date";
  if (/^(open|ouverture|ouv\.?|opening|opening price|premier|premier cours|cours d'ouverture)$/.test(h)) return "open";
  if (/^(high|haut|plus haut|\+ ?haut|highest)$/.test(h)) return "high";
  if (/^(low|bas|plus bas|- ?bas|lowest)$/.test(h)) return "low";
  if (/^(close|cloture|closing|closing price|dernier cours|cours de cloture)$/.test(h)) return "close";
  if (h === "vwap") return "vwap";
  if (/^(volume|volumes|number of shares|nb titres|nombre de titres|quantite|volume \(titres\))$/.test(h)) return "volume";
  return null;
}
function parsePriceCsv(text) {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const delimiter = detectDelimiter(lines);
  const errors = [];
  let headerIdx = -1;
  let columns = [];
  for (let i = 0; i < Math.min(lines.length, 30); i++) {
    const cells = splitCsvLine(lines[i], delimiter).map(normalizeHeader);
    const cols = cells.map(priceColumn);
    if (cols.includes("date") && (cols.includes("open") || cols.includes("close") || cells.includes("last"))) {
      headerIdx = i;
      columns = cols;
      if (!cols.includes("close")) {
        const lastIdx = cells.indexOf("last");
        if (lastIdx >= 0) columns[lastIdx] = "close";
      }
      break;
    }
  }
  if (headerIdx < 0) {
    return {
      rows: [],
      errors: [
        "en-t\xEAte introuvable : il faut au moins une colonne Date et Open ou Close"
      ],
      header: [],
      delimiter
    };
  }
  const header = splitCsvLine(lines[headerIdx], delimiter);
  const byDate = /* @__PURE__ */ new Map();
  for (let i = headerIdx + 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i], delimiter);
    const row = {
      date: ""
    };
    columns.forEach((col, j) => {
      if (!col) return;
      if (col === "date") row.date = parseDateCell(cells[j]) ?? "";
      else row[col] = parseDecimal(cells[j]);
    });
    if (!row.date) {
      errors.push(`ligne ${i + 1} : date illisible (${cells[columns.indexOf("date")] ?? ""})`);
      continue;
    }
    for (const k of [
      "open",
      "high",
      "low",
      "close",
      "vwap"
    ]) {
      const v = row[k];
      if (v !== null && v !== void 0) {
        if (!(v > 0)) {
          errors.push(`ligne ${i + 1} : ${k} invalide`);
          row[k] = null;
        } else row[k] = round43(v);
      }
    }
    if (row.open == null && row.close == null) {
      errors.push(`ligne ${i + 1} : ni ouverture ni cl\xF4ture`);
      continue;
    }
    if (byDate.has(row.date)) errors.push(`ligne ${i + 1} : date en double ${row.date}, la derni\xE8re ligne l'emporte`);
    byDate.set(row.date, row);
  }
  const rows = [
    ...byDate.values()
  ].sort((a, b) => a.date < b.date ? -1 : 1);
  return {
    rows,
    errors,
    header,
    delimiter
  };
}
var ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  euro: "\u20AC"
};
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
function htmlTableToCsv(html) {
  const table = /<table[\s\S]*?<\/table>/i.exec(html)?.[0] ?? html;
  const rows = [];
  for (const tr of table.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
    const cells = [
      ...tr.matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)
    ].map((m) => decodeEntities(m[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim().replace(/;/g, ","));
    if (cells.length > 0) rows.push(cells.join(";"));
  }
  return rows.join("\n");
}
function round43(v) {
  return Math.round(v * 1e4) / 1e4;
}

// supabase/functions/_shared/core/yahoo.ts
function clean(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v * 1e4) / 1e4 : null;
}
function parseYahooChart(json2) {
  const chart = json2?.chart;
  if (!chart) throw new Error("r\xE9ponse Yahoo illisible");
  if (chart.error) throw new Error(`Yahoo : ${chart.error.description ?? "erreur"}`);
  const result = chart.result?.[0];
  if (!result) throw new Error("Yahoo : aucun r\xE9sultat");
  const meta = result.meta ?? {};
  const ts = result.timestamp ?? [];
  const q = result.indicators?.quote?.[0] ?? {};
  const byDate = /* @__PURE__ */ new Map();
  ts.forEach((t, i) => {
    const date = parisDateOf(t * 1e3);
    const bar = {
      date,
      open: clean(q.open?.[i]),
      high: clean(q.high?.[i]),
      low: clean(q.low?.[i]),
      close: clean(q.close?.[i]),
      volume: typeof q.volume?.[i] === "number" ? q.volume?.[i] : null
    };
    if (bar.open === null && bar.close === null) return;
    const prev = byDate.get(date);
    if (!prev) {
      byDate.set(date, bar);
      return;
    }
    byDate.set(date, {
      date,
      open: prev.open ?? bar.open,
      high: maxOf(prev.high, bar.high),
      low: minOf(prev.low, bar.low),
      close: bar.close ?? prev.close,
      volume: maxOf(prev.volume ?? null, bar.volume ?? null)
    });
  });
  const num2 = (k) => typeof meta[k] === "number" ? meta[k] : null;
  const time = num2("regularMarketTime");
  const dividends = Object.values(result.events?.dividends ?? {}).filter((d) => typeof d.amount === "number" && d.amount > 0 && typeof d.date === "number").map((d) => ({
    exDate: parisDateOf(d.date * 1e3),
    amount: Math.round(d.amount * 1e4) / 1e4
  })).sort((a, b) => a.exDate < b.exDate ? -1 : 1);
  return {
    symbol: String(meta.symbol ?? ""),
    currency: typeof meta.currency === "string" ? meta.currency : null,
    timezone: typeof meta.exchangeTimezoneName === "string" ? meta.exchangeTimezoneName : null,
    bars: [
      ...byDate.values()
    ].sort((a, b) => a.date < b.date ? -1 : 1),
    regularMarketPrice: clean(num2("regularMarketPrice")),
    regularMarketTime: time === null ? null : time * 1e3,
    previousClose: clean(num2("previousClose") ?? num2("chartPreviousClose")),
    dividends
  };
}
function maxOf(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.max(a, b);
}
function minOf(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  return Math.min(a, b);
}

// supabase/functions/_shared/core/index.ts
var CORE_VERSION = "1.0.0";

// supabase/functions/castor-jobs/db.ts
import { createClient } from "npm:@supabase/supabase-js@2.117.2";
function privilegedKey() {
  const raw = Deno.env.get("SUPABASE_SECRET_KEYS");
  if (raw) {
    try {
      const keys = JSON.parse(raw);
      const key = keys.default ?? Object.values(keys)[0];
      if (typeof key === "string" && key) return key;
    } catch {
    }
  }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || void 0;
}
function serviceClient() {
  const url = Deno.env.get("SUPABASE_URL");
  const key = privilegedKey();
  if (!url || !key) {
    throw new Error("SUPABASE_URL ou cl\xE9 de service (SUPABASE_SECRET_KEYS, SUPABASE_SERVICE_ROLE_KEY) absente de l\u2019environnement des fonctions");
  }
  return createClient(url, key, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    }
  });
}
async function must(query, label) {
  const { data, error } = await query;
  if (error) throw new Error(`${label} : ${error.message}`);
  return data;
}
async function selectAll(page, label, size = 1e3) {
  const out = [];
  for (let from = 0; ; ) {
    const { data, error } = await page(from, from + size - 1);
    if (error) throw new Error(`${label} : ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...data);
    from += data.length;
  }
  return out;
}
async function loadConfig(db) {
  const cfg = await must(db.from("app_config").select("*").maybeSingle(), "r\xE9glages");
  if (!cfg) throw new Error("r\xE9glages absents (table app_config vide)");
  return cfg;
}
async function loadCalendar(db) {
  const rows = await must(db.from("market_holidays").select("day, half_day"), "jours f\xE9ri\xE9s");
  const closures = rows.filter((r) => !r.half_day).map((r) => r.day);
  return {
    calendar: new TradingCalendar(closures),
    closures
  };
}
function toEstimateParams(p) {
  return {
    ...DEFAULT_ESTIMATE,
    windowDays: p.window_days,
    discountBps: p.discount_bps,
    priceField: p.price_field,
    rounding: p.rounding,
    excludeBoardDay: p.exclude_board_day,
    toleranceBps: p.tolerance_bps,
    nSims: p.n_sims,
    bootstrapDays: p.bootstrap_days,
    modelSigmaBps: Number(p.model_sigma_bps)
  };
}
async function loadMarket(db) {
  const [config, paramsRow, cal, rows, dividends, quads, quote] = await Promise.all([
    loadConfig(db),
    must(db.from("calc_params").select("*").eq("active", true).maybeSingle(), "param\xE8tres actifs"),
    loadCalendar(db),
    selectAll((from, to) => db.from("stock_prices").select("trade_date, open, high, low, close, vwap, volume, is_manual, check_open, check_close, check_at").order("trade_date").range(from, to), "cours"),
    must(db.from("dividends").select("ex_date, amount").order("ex_date"), "dividendes"),
    must(db.from("quadrimesters").select("*").order("start_date"), "quadrimestres"),
    must(db.from("quote_live").select("*").maybeSingle(), "cours en s\xE9ance")
  ]);
  if (!paramsRow) throw new Error("aucune version de param\xE8tres active");
  const params = paramsRow;
  return {
    config,
    params,
    estimateParams: toEstimateParams(params),
    calendar: cal.calendar,
    closures: cal.closures,
    rows,
    sessions: rows.map((r) => ({
      date: r.trade_date,
      open: num(r.open),
      high: num(r.high),
      low: num(r.low),
      close: num(r.close),
      vwap: num(r.vwap)
    })),
    dividends: dividends.map((d) => ({
      exDate: d.ex_date,
      amount: Number(d.amount)
    })),
    quads: quads.map((q) => ({
      ...q,
      official_price: num(q.official_price),
      computed_price: num(q.computed_price)
    })),
    quote: quote ? {
      ...quote,
      price: Number(quote.price)
    } : null
  };
}
function toJson(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}
function num(v) {
  if (v === null || v === void 0 || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function boardSpecOf(q) {
  if (q.board_date) return {
    mode: "date",
    date: q.board_date
  };
  if (q.board_slot_start && q.board_slot_end) {
    return {
      mode: "slot",
      start: q.board_slot_start,
      end: q.board_slot_end,
      weights: q.board_weights
    };
  }
  const slot = defaultBoardSlot(q.code);
  return {
    mode: "slot",
    start: slot.start,
    end: slot.end
  };
}

// supabase/functions/castor-jobs/http.ts
var corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  // En-têtes envoyés par supabase-js (liste de @supabase/supabase-js/cors) + secret des tâches planifiées.
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-retry-count, traceparent, tracestate, baggage, x-castor-cron",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS"
};
var HttpError = class extends Error {
  status;
  constructor(status, message) {
    super(message), this.status = status;
  }
};
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}
function errorMessage(e) {
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) return String(e.message);
  return String(e);
}

// supabase/functions/castor-jobs/providers.ts
var USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36 CastorTracker/1.0";
var YAHOO_HOSTS = [
  "https://query1.finance.yahoo.com",
  "https://query2.finance.yahoo.com"
];
function epoch(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1e3);
}
async function fetchYahoo(symbol, opts) {
  const qs = new URLSearchParams({
    interval: "1d",
    includePrePost: "false",
    events: "div"
  });
  if (opts.range) qs.set("range", opts.range);
  else {
    qs.set("period1", String(epoch(opts.from ?? "2015-01-01")));
    qs.set("period2", String(epoch(opts.to ?? (/* @__PURE__ */ new Date()).toISOString().slice(0, 10)) + 2 * 86400));
  }
  const errors = [];
  for (const host of YAHOO_HOSTS) {
    try {
      const res = await fetch(`${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs}`, {
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "application/json"
        },
        signal: AbortSignal.timeout(2e4)
      });
      if (!res.ok) {
        errors.push(`${new URL(host).hostname} : HTTP ${res.status}`);
        continue;
      }
      return parseYahooChart(await res.json());
    } catch (e) {
      errors.push(`${new URL(host).hostname} : ${e.message}`);
    }
  }
  throw new Error(`Yahoo indisponible (${errors.join(" ; ")})`);
}
var EURONEXT_DEFAULT = "https://live.euronext.com/en/ajax/AwlHistoricalPrice/getFullDownloadAjax/{code}?format=csv&decimal_separator=.&date_form=d/m/Y&op=&adjusted=N&base100=&startdate={from}&enddate={to}";
var EURONEXT_POPUP = "https://live.euronext.com/en/ajax/getHistoricalPricePopup/{code}";
async function fetchEuronext(code, from, to, template) {
  const fill = (t) => t.replaceAll("{code}", encodeURIComponent(code)).replaceAll("{from}", from).replaceAll("{to}", to);
  const errors = [];
  try {
    const res = await fetch(fill(template || EURONEXT_DEFAULT), {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "text/csv,text/plain,*/*"
      },
      signal: AbortSignal.timeout(2e4)
    });
    if (res.ok) {
      const parsed = parsePriceCsv(await res.text());
      if (parsed.rows.length > 0) return parsed.rows;
      errors.push(`CSV illisible (${parsed.errors[0] ?? "aucune ligne"})`);
    } else errors.push(`CSV : HTTP ${res.status}`);
  } catch (e) {
    errors.push(`CSV : ${e.message}`);
  }
  try {
    const sessions = Math.min(400, Math.max(10, Math.ceil((Date.parse(to) - Date.parse(from)) / 864e5)));
    const res = await fetch(fill(EURONEXT_POPUP), {
      method: "POST",
      headers: {
        "User-Agent": USER_AGENT,
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest"
      },
      body: new URLSearchParams({
        adjusted: "N",
        startdate: from,
        enddate: to,
        nbSession: String(sessions)
      }),
      signal: AbortSignal.timeout(2e4)
    });
    if (res.ok) {
      const parsed = parsePriceCsv(htmlTableToCsv(await res.text()));
      if (parsed.rows.length > 0) return parsed.rows.filter((r) => r.date >= from && r.date <= to);
      errors.push("page historique illisible");
    } else errors.push(`page historique : HTTP ${res.status}`);
  } catch (e) {
    errors.push(`page historique : ${e.message}`);
  }
  throw new Error(`Euronext indisponible (${errors.join(" ; ")})`);
}

// supabase/functions/castor-jobs/tasks.ts
var OPEN_FROM = 9 * 60 + 10;
var OPEN_UNTIL = 12 * 60;
var QUOTE_FROM = 9 * 60;
var QUOTE_UNTIL = 17 * 60 + 50;
var SESSION_FROM = 17 * 60 + 50;
var CATCHUP_FROM = 7 * 60;
var CATCHUP_UNTIL = 9 * 60 + 5;
var fr = (v, digits = 2) => v.toLocaleString("fr-FR", {
  minimumFractionDigits: digits,
  maximumFractionDigits: digits
});
var hhmm = (minutes) => `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
async function lastRun(db, job, status = "success") {
  const row = await must(db.from("job_runs").select("started_at").eq("job", job).eq("status", status).order("started_at", {
    ascending: false
  }).limit(1).maybeSingle(), "journal");
  return row?.started_at ?? null;
}
async function succeededToday(ctx, job) {
  const at = await lastRun(ctx.db, job);
  return at !== null && parisDateOf(Date.parse(at)) === ctx.clock.date;
}
async function sessionRow(db, date) {
  return await must(db.from("stock_prices").select("trade_date, open, close, check_at").eq("trade_date", date).maybeSingle(), "s\xE9ance");
}
function completedBars(bars, clock) {
  return bars.filter((b) => b.date < clock.date || b.date === clock.date && clock.minutes >= SESSION_FROM);
}
async function storeBars(db, bars, source, mode) {
  if (bars.length === 0) return 0;
  const rows = bars.map((b) => ({
    date: b.date,
    open: b.open ?? null,
    high: b.high ?? null,
    low: b.low ?? null,
    close: b.close ?? null,
    vwap: b.vwap ?? null,
    volume: b.volume ?? null
  }));
  let total = 0;
  for (let i = 0; i < rows.length; i += 1e3) {
    const res = await must(db.rpc("upsert_prices", {
      p_rows: rows.slice(i, i + 1e3),
      p_source: source,
      p_mode: mode
    }), "\xE9criture des cours");
    total += res.upserted ?? 0;
  }
  return total;
}
async function storeDividends(db, chart) {
  if (chart.dividends.length === 0) return 0;
  const rows = chart.dividends.map((d) => ({
    ex_date: d.exDate,
    amount: d.amount,
    kind: Number(d.exDate.slice(5, 7)) >= 9 ? "acompte" : "solde",
    source: "yahoo"
  }));
  const res = await must(db.from("dividends").upsert(rows, {
    onConflict: "ex_date",
    ignoreDuplicates: true
  }).select("ex_date"), "dividendes");
  return res?.length ?? 0;
}
async function storeQuote(db, chart) {
  const price = chart.regularMarketPrice;
  if (!price) return null;
  const time = chart.regularMarketTime ?? Date.now();
  const day = parisDateOf(time);
  const dayBar = chart.bars.find((b) => b.date === day);
  const prevBar = [
    ...chart.bars
  ].reverse().find((b) => b.date < day && b.close);
  const prevClose = prevBar?.close ?? chart.previousClose ?? null;
  await must(db.from("quote_live").upsert({
    id: true,
    price,
    prev_close: prevClose,
    change_pct: prevClose ? Math.round((price / prevClose - 1) * 1e6) / 1e6 : null,
    day_open: dayBar?.open ?? null,
    quote_time: new Date(time).toISOString(),
    source: "yahoo",
    fetched_at: (/* @__PURE__ */ new Date()).toISOString()
  }), "cours en s\xE9ance");
  return {
    price,
    day
  };
}
async function controlWithEuronext(db, config, from, to) {
  let rows;
  try {
    rows = await fetchEuronext(config.euronext_code, from, to, config.euronext_history_url);
  } catch (e) {
    return {
      checked: 0,
      spreads: [],
      error: e.message
    };
  }
  const res = await must(db.rpc("upsert_prices", {
    p_rows: rows.map((r) => ({
      date: r.date,
      open: r.open ?? null,
      close: r.close ?? null,
      vwap: r.vwap ?? null
    })),
    p_source: "euronext",
    p_mode: "control"
  }), "contr\xF4le Euronext");
  const ours = await must(db.from("stock_prices").select("trade_date, open, close").gte("trade_date", from).lte("trade_date", to), "cours contr\xF4l\xE9s");
  const byDate = new Map(ours.map((o) => [
    o.trade_date,
    o
  ]));
  const spreads = [];
  for (const r of rows) {
    const o = byDate.get(r.date);
    if (!o) continue;
    for (const field of [
      "open",
      "close"
    ]) {
      const a = num(o[field]);
      const b = r[field] ?? null;
      if (a && b) {
        const bps = Math.round(Math.abs(b - a) / a * 1e5) / 10;
        if (bps > config.alert_spread_bps) spreads.push({
          date: r.date,
          field,
          ours: a,
          theirs: b,
          bps
        });
      }
    }
  }
  return {
    checked: res.updated ?? 0,
    spreads
  };
}
function formulaOf(market) {
  const p = market.estimateParams;
  return {
    windowDays: p.windowDays,
    discountBps: p.discountBps,
    rounding: p.rounding,
    excludeBoardDay: p.excludeBoardDay,
    priceField: p.priceField
  };
}
async function refreshComputedPrices(db, market) {
  const index = indexSessions(market.sessions);
  const formula = formulaOf(market);
  let changed = 0;
  for (const q of market.quads) {
    let price = null;
    let missing = null;
    if (q.board_date) {
      const ev = evaluateWindow(index, market.calendar, q.board_date, formula);
      price = ev.price;
      missing = ev.missing.length;
    }
    if (price !== q.computed_price || missing !== q.computed_missing) {
      await must(db.from("quadrimesters").update({
        computed_price: price,
        computed_missing: missing,
        computed_at: (/* @__PURE__ */ new Date()).toISOString()
      }).eq("code", q.code), "prix recalcul\xE9");
      q.computed_price = price;
      q.computed_missing = missing;
      changed++;
    }
  }
  return changed;
}
function lastKnownPrice(market, asOf) {
  let best = null;
  for (let i = market.sessions.length - 1; i >= 0; i--) {
    const s = market.sessions[i];
    if (s.date > asOf) continue;
    const v = s.close ?? s.open;
    if (v) {
      best = {
        price: v,
        date: s.date
      };
      break;
    }
  }
  if (market.quote) {
    const qDate = parisDateOf(Date.parse(market.quote.quote_time));
    if (qDate <= asOf && (!best || qDate >= best.date)) best = {
      price: Number(market.quote.price),
      date: qDate
    };
  }
  return best;
}
function referencePriceFor(market, target, today) {
  const current = market.quads.find((q) => q.start_date <= today && q.end_date >= today);
  if (current?.official_price) return current.official_price;
  const previous = market.quads.filter((q) => q.start_date < target.start_date && q.official_price).sort((a, b) => a.start_date < b.start_date ? 1 : -1)[0];
  return previous?.official_price ?? null;
}
function estimateRow(code, kind, market, r, board, extra = {}) {
  const probable = r.candidates.find((c) => c.date === r.mostProbableDate);
  const index = indexSessions(market.sessions);
  const windowDates = probable ? market.calendar.sessionsBetween(probable.windowStart, probable.windowEnd) : [];
  return {
    quadrimester_code: code,
    kind,
    as_of: r.asOf,
    last_price: r.lastPrice || null,
    last_price_date: r.lastPriceDate,
    params_id: market.params.id,
    seed: r.seed,
    n_sims: r.nSims,
    state: r.state,
    central: r.central,
    p05: r.p05,
    p25: r.p25,
    p75: r.p75,
    p95: r.p95,
    reliability: r.reliability,
    prob_below: r.probBelow,
    reference_price: r.referencePrice,
    known_sessions: r.knownMostProbable,
    known_min: r.knownMin,
    known_max: r.knownMax,
    most_probable_date: r.mostProbableDate,
    window_start: r.windowUnion.start,
    window_end: r.windowUnion.end,
    board: toJson(board),
    details: toJson({
      coreVersion: CORE_VERSION,
      candidates: r.candidates,
      warnings: r.warnings,
      sigmaDaily: r.sigmaDaily,
      returnsUsed: r.returnsUsed,
      simulated: r.simulatedSessions.length,
      deterministic: r.deterministic,
      window: windowDates.map((d) => {
        const v = d <= r.asOf ? index.get(d)?.[market.estimateParams.priceField] ?? null : null;
        return {
          date: d,
          value: v,
          known: d <= r.asOf && v !== null
        };
      }),
      ...extra
    })
  };
}
async function estimateAndStore(ctx, market, kind, code) {
  const today = ctx.clock.date;
  const target = code ? market.quads.find((q) => q.code === code) : market.quads.filter((q) => q.start_date > today && q.official_price === null)[0];
  if (!target) {
    return {
      message: code ? `quadrimestre ${code} introuvable` : "aucun quadrimestre \xE0 estimer (lancer la maintenance)"
    };
  }
  if (target.official_price !== null) {
    return {
      message: `${target.code} : prix officiel d\xE9j\xE0 connu (${fr(target.official_price)} \u20AC)`
    };
  }
  const board = boardSpecOf(target);
  const last = lastKnownPrice(market, today);
  if (!last) throw new Error("aucun cours en base : lancer d\u2019abord la reprise de l\u2019historique");
  const result = estimate({
    sessions: market.sessions,
    asOf: today,
    lastPrice: last.price,
    lastPriceDate: last.date,
    board,
    params: market.estimateParams,
    dividends: market.dividends,
    calendar: market.calendar,
    referencePrice: referencePriceFor(market, target, today),
    seed: randomSeed()
  });
  const row = await must(ctx.db.from("estimates").insert(estimateRow(target.code, kind, market, result, board)).select("id").single(), "enregistrement de l\u2019estimation");
  return {
    message: `${target.code} : ${fr(result.central)} \u20AC [${fr(result.p05)} \u2013 ${fr(result.p95)}], IF ${Math.round(result.reliability)}`,
    estimateId: row.id,
    details: {
      code: target.code,
      state: result.state,
      central: result.central,
      p05: result.p05,
      p95: result.p95,
      reliability: result.reliability,
      known: result.knownMostProbable,
      warnings: result.warnings
    }
  };
}
function missingSessions(market, from, to) {
  const index = indexSessions(market.sessions);
  return market.calendar.sessionsBetween(from, to).filter((d) => {
    const s = index.get(d);
    return !s || !s.open || !s.close;
  });
}
async function tradingGate(ctx, from, until) {
  const { calendar } = await loadCalendar(ctx.db);
  if (!calendar.isTradingDay(ctx.clock.date)) return "pas de s\xE9ance aujourd\u2019hui";
  if (ctx.clock.minutes < from || ctx.clock.minutes > until) {
    return `hors plage (${hhmm(ctx.clock.minutes)}, attendu ${hhmm(from)} \u2013 ${hhmm(until)})`;
  }
  return null;
}
var openTask = {
  cron: true,
  async gate(ctx) {
    const reason = await tradingGate(ctx, OPEN_FROM, OPEN_UNTIL);
    if (reason) return reason;
    const row = await sessionRow(ctx.db, ctx.clock.date);
    return row?.open ? "ouverture du jour d\xE9j\xE0 en base" : null;
  },
  async run(ctx) {
    const config = await loadConfig(ctx.db);
    const chart = await fetchYahoo(config.yahoo_symbol, {
      range: "5d"
    });
    const today = chart.bars.find((b) => b.date === ctx.clock.date);
    await storeQuote(ctx.db, chart);
    await storeBars(ctx.db, completedBars(chart.bars, ctx.clock), "yahoo", "full");
    if (!today?.open) throw new Error("ouverture du jour pas encore publi\xE9e par Yahoo");
    await storeBars(ctx.db, [
      today
    ], "yahoo", "open");
    const market = await loadMarket(ctx.db);
    const est = await estimateAndStore(ctx, market, ctx.caller.trigger === "cron" ? "scheduled" : "manual");
    return {
      message: `ouverture ${fr(today.open)} \u20AC ; ${est.message}`,
      details: {
        open: today.open,
        estimate: est.details
      }
    };
  }
};
var quoteTask = {
  cron: true,
  log: false,
  gate: (ctx) => tradingGate(ctx, QUOTE_FROM, QUOTE_UNTIL),
  async run(ctx) {
    const config = await loadConfig(ctx.db);
    const chart = await fetchYahoo(config.yahoo_symbol, {
      range: "5d"
    });
    const quote = await storeQuote(ctx.db, chart);
    const today = chart.bars.find((b) => b.date === ctx.clock.date);
    let estimateMessage = null;
    if (today?.open && ctx.clock.minutes >= OPEN_FROM) {
      const row = await sessionRow(ctx.db, ctx.clock.date);
      if (!row?.open) {
        await storeBars(ctx.db, [
          today
        ], "yahoo", "open");
        const market = await loadMarket(ctx.db);
        estimateMessage = (await estimateAndStore(ctx, market, "scheduled")).message;
      }
    }
    return {
      message: quote ? `cours ${fr(quote.price)} \u20AC` : "cours indisponible",
      details: {
        quote,
        estimate: estimateMessage
      }
    };
  }
};
var sessionTask = {
  cron: true,
  async gate(ctx) {
    const reason = await tradingGate(ctx, SESSION_FROM, 23 * 60 + 59);
    if (reason) return reason;
    const row = await sessionRow(ctx.db, ctx.clock.date);
    if (row?.close && await succeededToday(ctx, "session")) return "s\xE9ance du jour d\xE9j\xE0 compl\xE8te";
    return null;
  },
  async run(ctx) {
    const config = await loadConfig(ctx.db);
    const warnings = [];
    let stored = 0;
    let dividends = 0;
    try {
      const chart = await fetchYahoo(config.yahoo_symbol, {
        range: "1mo"
      });
      stored = await storeBars(ctx.db, completedBars(chart.bars, ctx.clock), "yahoo", "full");
      dividends = await storeDividends(ctx.db, chart);
      await storeQuote(ctx.db, chart);
    } catch (e) {
      warnings.push(e.message);
      const rows = await fetchEuronext(config.euronext_code, addDays(ctx.clock.date, -30), ctx.clock.date, config.euronext_history_url);
      stored = await storeBars(ctx.db, completedBars(rows, ctx.clock), "euronext", "full");
      warnings.push(`repli sur Euronext : ${stored} s\xE9ance(s)`);
    }
    const control = await controlWithEuronext(ctx.db, config, addDays(ctx.clock.date, -14), ctx.clock.date);
    if (control.error) warnings.push(`contr\xF4le Euronext impossible : ${control.error}`);
    const market = await loadMarket(ctx.db);
    const todayRow = market.rows.find((r) => r.trade_date === ctx.clock.date);
    if (!todayRow?.close) throw new Error("cl\xF4ture du jour absente des sources");
    const est = await estimateAndStore(ctx, market, ctx.caller.trigger === "cron" ? "scheduled" : "manual");
    await refreshComputedPrices(ctx.db, market);
    const alert = control.spreads.length > 0 ? ` ; \xC9CART de sources sur ${control.spreads.length} cours` : "";
    return {
      message: `s\xE9ance du ${ctx.clock.date} : cl\xF4ture ${fr(Number(todayRow.close))} \u20AC${alert} ; ${est.message}`,
      details: {
        stored,
        dividends,
        control,
        warnings,
        estimate: est.details
      }
    };
  }
};
var catchupTask = {
  cron: true,
  async gate(ctx) {
    if (ctx.clock.minutes < CATCHUP_FROM || ctx.clock.minutes > CATCHUP_UNTIL) {
      return `hors plage (${hhmm(ctx.clock.minutes)})`;
    }
    return await succeededToday(ctx, "catchup") ? "rattrapage d\xE9j\xE0 fait aujourd\u2019hui" : null;
  },
  async run(ctx) {
    const config = await loadConfig(ctx.db);
    const days = Math.min(400, Math.max(5, Number(ctx.body.days ?? 30)));
    const from = addDays(ctx.clock.date, -days - 10);
    const warnings = [];
    let stored = 0;
    let dividends = 0;
    try {
      const chart = await fetchYahoo(config.yahoo_symbol, {
        from,
        to: ctx.clock.date
      });
      stored = await storeBars(ctx.db, completedBars(chart.bars, ctx.clock), "yahoo", "full");
      dividends = await storeDividends(ctx.db, chart);
      await storeQuote(ctx.db, chart);
    } catch (e) {
      warnings.push(e.message);
      try {
        const rows = await fetchEuronext(config.euronext_code, from, ctx.clock.date, config.euronext_history_url);
        stored = await storeBars(ctx.db, completedBars(rows, ctx.clock), "euronext", "full");
        warnings.push(`repli sur Euronext : ${stored} s\xE9ance(s)`);
      } catch (e2) {
        throw new Error(`aucune source disponible : ${warnings[0]} ; ${e2.message}`);
      }
    }
    const control = await controlWithEuronext(ctx.db, config, from, ctx.clock.date);
    if (control.error) warnings.push(`contr\xF4le Euronext impossible : ${control.error}`);
    const market = await loadMarket(ctx.db);
    const lastClosed = ctx.clock.minutes >= SESSION_FROM ? ctx.clock.date : addDays(ctx.clock.date, -1);
    const missing = missingSessions(market, addDays(ctx.clock.date, -days), lastClosed);
    await refreshComputedPrices(ctx.db, market);
    const est = await estimateAndStore(ctx, market, ctx.caller.trigger === "cron" ? "scheduled" : "manual");
    return {
      message: `${stored} s\xE9ance(s) \xE9crite(s), ${missing.length} manquante(s) sur ${days} jours ; ${est.message}`,
      details: {
        stored,
        dividends,
        missing,
        control,
        warnings
      }
    };
  }
};
var historyTask = {
  cron: true,
  async run(ctx) {
    const config = await loadConfig(ctx.db);
    const from = String(ctx.body.from ?? "2015-01-01");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new HttpError(400, "date de d\xE9but invalide");
    const chart = await fetchYahoo(config.yahoo_symbol, {
      from,
      to: ctx.clock.date
    });
    const bars = completedBars(chart.bars, ctx.clock);
    const stored = await storeBars(ctx.db, bars, "yahoo", "full");
    const dividends = await storeDividends(ctx.db, chart);
    await storeQuote(ctx.db, chart);
    const controlFrom = String(ctx.body.controlFrom ?? addDays(ctx.clock.date, -365));
    const control = await controlWithEuronext(ctx.db, config, controlFrom, ctx.clock.date);
    const market = await loadMarket(ctx.db);
    const recalculated = await refreshComputedPrices(ctx.db, market);
    return {
      message: `${stored} s\xE9ance(s) depuis le ${from}, ${dividends} dividende(s) ajout\xE9(s), ${recalculated} prix recalcul\xE9(s)`,
      details: {
        stored,
        first: bars[0]?.date ?? null,
        last: bars[bars.length - 1]?.date ?? null,
        dividends,
        control,
        missing: missingSessions(market, from, bars[bars.length - 1]?.date ?? from).slice(0, 200)
      }
    };
  }
};
var estimateTask = {
  cron: true,
  async run(ctx) {
    const market = await loadMarket(ctx.db);
    await refreshComputedPrices(ctx.db, market);
    const code = typeof ctx.body.code === "string" ? ctx.body.code : void 0;
    return estimateAndStore(ctx, market, ctx.caller.trigger === "cron" ? "scheduled" : "manual", code);
  }
};
function referencesOf(market, statuses) {
  return market.quads.filter((q) => q.official_price && q.board_date && statuses.includes(q.board_status)).map((q) => ({
    code: q.code,
    boardDate: q.board_date,
    officialPrice: q.official_price
  }));
}
var backtestTask = {
  cron: true,
  async run(ctx) {
    const market = await loadMarket(ctx.db);
    const references = referencesOf(market, [
      "known"
    ]);
    const report = runBacktest({
      sessions: market.sessions,
      references,
      calendar: market.calendar,
      base: formulaOf(market)
    });
    const active = variantKey(market.estimateParams);
    const summarize = (v) => ({
      key: v.key,
      label: v.label,
      variant: v.variant,
      n: v.n,
      nExact: v.nExact,
      nMissing: v.nMissing,
      exactRate: v.exactRate,
      mae: v.mae,
      maxAbs: v.maxAbs,
      sigmaBps: v.sigmaBps
    });
    const best = report.best;
    await must(ctx.db.from("backtests").insert({
      kind: "formula",
      params: toJson({
        references: references.length,
        windowDays: market.params.window_days,
        discountBps: market.params.discount_bps
      }),
      summary: toJson({
        active,
        best: best ? summarize(best) : null,
        exact: report.exact?.key ?? null,
        variants: report.variants.map(summarize)
      }),
      results: toJson({
        variants: report.variants
      }),
      exact_rate: best?.exactRate ?? null,
      mae: best?.mae ?? null,
      run_by: ctx.caller.userId
    }), "enregistrement du backtest");
    await refreshComputedPrices(ctx.db, market);
    const message = references.length === 0 ? "aucun prix de r\xE9f\xE9rence avec date de CA connue" : report.exact ? `variante exacte : ${report.exact.label} (${report.exact.nExact}/${report.exact.n})${report.exact.key === active ? ", d\xE9j\xE0 active" : ""}` : `aucune variante exacte ; meilleure : ${best?.label ?? "\u2014"} (${best?.nExact ?? 0}/${best?.n ?? 0}, \xE9cart moyen ${best?.mae === null || best?.mae === void 0 ? "\u2014" : fr(best.mae)} \u20AC)`;
    return {
      message,
      details: {
        references: references.length,
        active,
        exact: report.exact?.key ?? null
      }
    };
  }
};
function presumedDate(market, q) {
  if (q.board_date) return q.board_date;
  const spec = q.board_slot_start && q.board_slot_end ? {
    mode: "slot",
    start: q.board_slot_start,
    end: q.board_slot_end
  } : {
    mode: "slot",
    ...defaultBoardSlot(q.code)
  };
  return mostProbable(candidateDates(market.calendar, spec)).date;
}
var inferTask = {
  cron: true,
  async run(ctx) {
    const market = await loadMarket(ctx.db);
    const apply = ctx.body.apply === true;
    const range = Math.min(120, Math.max(5, Number(ctx.body.rangeSessions ?? 60)));
    const targets = market.quads.filter((q) => q.official_price && q.board_status !== "known");
    const formula = formulaOf(market);
    const results = targets.map((q) => inferBoardDates({
      sessions: market.sessions,
      reference: {
        code: q.code,
        boardDate: null,
        officialPrice: q.official_price,
        presumedDate: presumedDate(market, q)
      },
      params: formula,
      calendar: market.calendar,
      rangeSessions: range
    }));
    let applied = 0;
    if (apply) {
      for (const r of results) {
        if (r.matches.length !== 1) continue;
        await must(ctx.db.from("quadrimesters").update({
          board_date: r.matches[0].date,
          board_status: "inferred",
          board_source: `Inf\xE9rence au centime (${ctx.clock.date})`
        }).eq("code", r.code), "date inf\xE9r\xE9e");
        applied++;
      }
    }
    await must(ctx.db.from("backtests").insert({
      kind: "inference",
      params: toJson({
        rangeSessions: range,
        apply,
        formula
      }),
      summary: toJson({
        targets: results.length,
        unique: results.filter((r) => r.matches.length === 1).length,
        ambiguous: results.filter((r) => r.matches.length > 1).length,
        none: results.filter((r) => r.matches.length === 0).length,
        applied
      }),
      results: toJson({
        inferences: results
      }),
      run_by: ctx.caller.userId
    }), "enregistrement de l\u2019inf\xE9rence");
    if (applied > 0) await refreshComputedPrices(ctx.db, await loadMarket(ctx.db));
    return {
      message: results.length === 0 ? "aucun prix officiel sans date de CA connue" : `${results.filter((r) => r.matches.length === 1).length}/${results.length} date(s) retrouv\xE9e(s) sans ambigu\xEFt\xE9${apply ? `, ${applied} appliqu\xE9e(s)` : ""}`,
      details: {
        results: results.map((r) => ({
          code: r.code,
          matches: r.matches.map((m) => m.date)
        }))
      }
    };
  }
};
function hashSeed(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
var REPLAY_CPU_MS = 600;
var REPLAY_MIN_SIMS = 400;
function replayCostMs(points, nSims) {
  return points * (0.9 + nSims * 11e-4);
}
function fitReplayBudget(references, daysBefore, nSims, step) {
  const points = (s) => references * Math.ceil(daysBefore / s);
  let sims = nSims;
  let pace = step;
  if (replayCostMs(points(pace), sims) > REPLAY_CPU_MS) sims = Math.min(sims, REPLAY_MIN_SIMS);
  while (replayCostMs(points(pace), sims) > REPLAY_CPU_MS && pace < daysBefore) pace++;
  return {
    nSims: sims,
    step: pace,
    reduced: sims !== nSims || pace !== step
  };
}
var replayTask = {
  cron: true,
  async run(ctx) {
    const market = await loadMarket(ctx.db);
    const references = referencesOf(market, [
      "known",
      "inferred"
    ]);
    const daysBefore = Math.min(120, Math.max(5, Number(ctx.body.daysBefore ?? 60)));
    const { nSims, step, reduced } = fitReplayBudget(references.length, daysBefore, Math.min(5e3, Math.max(200, Number(ctx.body.nSims ?? 1e3))), Math.min(10, Math.max(1, Number(ctx.body.step ?? 1))));
    const report = replayEstimates({
      sessions: market.sessions,
      references,
      params: market.estimateParams,
      dividends: market.dividends,
      calendar: market.calendar,
      daysBefore,
      step,
      nSims,
      seed: 20261007
    });
    await must(ctx.db.from("backtests").insert({
      kind: "replay",
      params: toJson({
        nSims,
        daysBefore,
        step
      }),
      summary: toJson({
        coverage: report.coverage,
        n: report.n,
        buckets: report.buckets,
        skipped: report.skipped
      }),
      results: toJson({
        points: report.points
      }),
      coverage: report.coverage,
      run_by: ctx.caller.userId
    }), "enregistrement du rejeu");
    const replayed = [];
    const skipped = [];
    for (const q of market.quads.filter((x) => x.official_price)) {
      const asOf = quadPeriod(prevQuad(q.code)).paymentClose;
      const last = lastKnownPrice({
        ...market,
        quote: null
      }, asOf);
      if (!last || market.sessions.length === 0 || market.sessions[0].date > addDays(asOf, -400)) {
        skipped.push(`${q.code} : cours insuffisants avant le ${asOf}`);
        continue;
      }
      const slot = defaultBoardSlot(q.code);
      const board = {
        mode: "slot",
        start: slot.start,
        end: slot.end
      };
      try {
        const result = estimate({
          sessions: market.sessions,
          asOf,
          lastPrice: last.price,
          lastPriceDate: last.date,
          board,
          params: {
            ...market.estimateParams,
            nSims: Math.max(nSims, 2e3)
          },
          dividends: market.dividends,
          calendar: market.calendar,
          referencePrice: market.quads.find((x) => x.code === prevQuad(q.code))?.official_price ?? null,
          seed: hashSeed(q.code)
        });
        await must(ctx.db.from("estimates").delete().eq("quadrimester_code", q.code).eq("kind", "replay"), "rejeu");
        await must(ctx.db.from("estimates").insert({
          ...estimateRow(q.code, "replay", market, result, board, {
            replayOf: "fermeture des versements pr\xE9c\xE9dents"
          }),
          computed_at: (/* @__PURE__ */ new Date()).toISOString()
        }), "rejeu");
        replayed.push(q.code);
      } catch (e) {
        skipped.push(`${q.code} : ${e.message}`);
      }
    }
    const coverage = report.coverage === null ? "\u2014" : `${fr(report.coverage * 100, 1)} %`;
    const pace = reduced ? ` (budget de calcul : ${nSims} tirages, un jour sur ${step})` : "";
    return {
      message: `couverture de l\u2019intervalle \xE0 90 % : ${coverage} sur ${report.n} points${pace} ; ${replayed.length} quadrimestre(s) rejou\xE9(s)`,
      details: {
        coverage: report.coverage,
        buckets: report.buckets,
        replayed,
        skipped: [
          ...report.skipped,
          ...skipped
        ],
        nSims,
        step
      }
    };
  }
};
var maintenanceTask = {
  cron: true,
  async gate(ctx) {
    const at = await lastRun(ctx.db, "maintenance");
    return at && parisDateOf(Date.parse(at)).slice(0, 7) === ctx.clock.date.slice(0, 7) ? "maintenance d\xE9j\xE0 faite ce mois-ci" : null;
  },
  async run(ctx) {
    const year = Number(ctx.clock.date.slice(0, 4));
    const holidays = [
      year,
      year + 1
    ].flatMap((y) => euronextHolidays(y).map((h) => ({
      day: h.date,
      label: h.label,
      half_day: false,
      source: "standard"
    })));
    const insertedHolidays = await must(ctx.db.from("market_holidays").upsert(holidays, {
      onConflict: "day",
      ignoreDuplicates: true
    }).select("day"), "jours f\xE9ri\xE9s");
    const existing = new Set((await must(ctx.db.from("quadrimesters").select("code"), "quadrimestres")).map((q) => q.code));
    const created = [];
    let code = quadrimesterOf(ctx.clock.date);
    for (let i = 0; i < 5; i++, code = nextQuad(code)) {
      if (existing.has(code)) continue;
      const p = quadPeriod(code);
      const slot = defaultBoardSlot(code);
      await must(ctx.db.from("quadrimesters").insert({
        code,
        start_date: p.start,
        end_date: p.end,
        payment_close_date: p.paymentClose,
        board_slot_start: slot.start,
        board_slot_end: slot.end,
        board_status: "estimated",
        board_source: "Cr\xE9neau par d\xE9faut (maintenance)"
      }), "cr\xE9ation de quadrimestre");
      created.push(code);
    }
    const purgeBefore = new Date(ctx.now.getTime() - 180 * 864e5).toISOString();
    const purged = await must(ctx.db.from("job_runs").delete().lt("started_at", purgeBefore).neq("status", "error").select("id"), "purge du journal");
    const market = await loadMarket(ctx.db);
    const recalculated = await refreshComputedPrices(ctx.db, market);
    return {
      message: `${created.length} quadrimestre(s) cr\xE9\xE9(s), ${insertedHolidays.length} fermeture(s) ajout\xE9e(s), ${purged.length} entr\xE9e(s) de journal purg\xE9e(s)`,
      details: {
        created,
        recalculated
      }
    };
  }
};
function requireRole(value) {
  if (value === "admin" || value === "viewer") return value;
  throw new HttpError(400, "r\xF4le attendu : admin ou viewer");
}
var usersTask = {
  cron: false,
  log: false,
  async run(ctx) {
    const { data, error } = await ctx.db.auth.admin.listUsers({
      page: 1,
      perPage: 500
    });
    if (error) throw new Error(error.message);
    const roles = await must(ctx.db.from("user_roles").select("user_id, role, created_at"), "r\xF4les");
    const byId = new Map(roles.map((r) => [
      r.user_id,
      r
    ]));
    return {
      message: `${data.users.length} compte(s)`,
      users: data.users.map((u) => ({
        id: u.id,
        email: u.email,
        role: byId.get(u.id)?.role ?? null,
        created_at: u.created_at,
        last_sign_in_at: u.last_sign_in_at ?? null,
        confirmed: Boolean(u.email_confirmed_at),
        mfa: (u.factors ?? []).some((f) => f.status === "verified")
      }))
    };
  }
};
var inviteTask = {
  cron: false,
  async run(ctx) {
    const email = String(ctx.body.email ?? "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new HttpError(400, "adresse e-mail invalide");
    const role = requireRole(ctx.body.role ?? "viewer");
    const config = await loadConfig(ctx.db);
    const redirectTo = config.site_url ?? void 0;
    let userId = null;
    let link = null;
    if (ctx.body.sendEmail === false) {
      const { data, error } = await ctx.db.auth.admin.generateLink({
        type: "invite",
        email,
        options: {
          redirectTo
        }
      });
      if (error) {
        const retry = await ctx.db.auth.admin.generateLink({
          type: "magiclink",
          email,
          options: {
            redirectTo
          }
        });
        if (retry.error) throw new Error(retry.error.message);
        userId = retry.data.user?.id ?? null;
        link = retry.data.properties?.action_link ?? null;
      } else {
        userId = data.user?.id ?? null;
        link = data.properties?.action_link ?? null;
      }
    } else {
      const { data, error } = await ctx.db.auth.admin.inviteUserByEmail(email, {
        redirectTo
      });
      if (error) throw new Error(`invitation impossible (${error.message}) : configurer le SMTP ou g\xE9n\xE9rer un lien`);
      userId = data.user?.id ?? null;
    }
    if (!userId) throw new Error("compte non cr\xE9\xE9");
    await must(ctx.db.from("user_roles").upsert({
      user_id: userId,
      role,
      invited_by: ctx.caller.userId
    }, {
      onConflict: "user_id"
    }), "r\xF4le");
    return {
      message: `${email} invit\xE9(e) comme ${role}`,
      userId,
      link,
      details: {
        email,
        role,
        link: Boolean(link)
      }
    };
  }
};
var setRoleTask = {
  cron: false,
  async run(ctx) {
    const userId = String(ctx.body.userId ?? "");
    if (!userId) throw new HttpError(400, "utilisateur manquant");
    if (userId === ctx.caller.userId) throw new HttpError(400, "impossible de modifier son propre r\xF4le");
    if (ctx.body.role === null) {
      await must(ctx.db.from("user_roles").delete().eq("user_id", userId), "retrait du r\xF4le");
      return {
        message: "acc\xE8s retir\xE9",
        details: {
          userId
        }
      };
    }
    const role = requireRole(ctx.body.role);
    await must(ctx.db.from("user_roles").upsert({
      user_id: userId,
      role,
      invited_by: ctx.caller.userId
    }, {
      onConflict: "user_id"
    }), "r\xF4le");
    return {
      message: `r\xF4le ${role} attribu\xE9`,
      details: {
        userId,
        role
      }
    };
  }
};
var deleteUserTask = {
  cron: false,
  async run(ctx) {
    const userId = String(ctx.body.userId ?? "");
    if (!userId) throw new HttpError(400, "utilisateur manquant");
    if (userId === ctx.caller.userId) throw new HttpError(400, "impossible de supprimer son propre compte");
    const { error } = await ctx.db.auth.admin.deleteUser(userId);
    if (error) throw new Error(error.message);
    return {
      message: "compte supprim\xE9",
      details: {
        userId
      }
    };
  }
};
var TASKS = {
  open: openTask,
  quote: quoteTask,
  session: sessionTask,
  catchup: catchupTask,
  history: historyTask,
  estimate: estimateTask,
  backtest: backtestTask,
  infer: inferTask,
  replay: replayTask,
  maintenance: maintenanceTask,
  users: usersTask,
  invite: inviteTask,
  "set-role": setRoleTask,
  "delete-user": deleteUserTask
};

// supabase/functions/castor-jobs/handler.ts
function decodeJwtPayload(token) {
  const part = token.split(".")[1];
  if (!part) return {};
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return {};
  }
}
async function authenticate(req, db) {
  const cronSecret = req.headers.get("x-castor-cron");
  if (cronSecret) {
    const ok = await must(db.rpc("castor_verify_cron_secret", {
      p_secret: cronSecret
    }), "secret planifi\xE9");
    if (ok !== true) throw new HttpError(401, "secret des t\xE2ches planifi\xE9es invalide");
    return {
      trigger: "cron",
      userId: null
    };
  }
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) throw new HttpError(401, "authentification requise");
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) throw new HttpError(401, "session invalide ou expir\xE9e");
  const [role, config] = await Promise.all([
    must(db.from("user_roles").select("role").eq("user_id", data.user.id).maybeSingle(), "r\xF4le"),
    must(db.from("app_config").select("admin_mfa_required").maybeSingle(), "r\xE9glages")
  ]);
  if (role?.role !== "admin") throw new HttpError(403, "r\xE9serv\xE9 aux administrateurs");
  const mfaRequired = config?.admin_mfa_required ?? true;
  if (mfaRequired && decodeJwtPayload(token).aal !== "aal2") {
    throw new HttpError(403, "second facteur (TOTP) requis pour l\u2019administration");
  }
  return {
    trigger: "admin",
    userId: data.user.id
  };
}
async function withJobLog(ctx, job, run) {
  const started = await must(ctx.db.from("job_runs").insert({
    job,
    trigger: ctx.caller.trigger,
    requested_by: ctx.caller.userId,
    status: "running"
  }).select("id").single(), "journal");
  const id = started.id;
  try {
    const result = await run();
    await ctx.db.from("job_runs").update({
      status: "success",
      finished_at: (/* @__PURE__ */ new Date()).toISOString(),
      message: result.message,
      details: result.details ? toJson(result.details) : null
    }).eq("id", id);
    return {
      ...result,
      runId: id
    };
  } catch (e) {
    await ctx.db.from("job_runs").update({
      status: "error",
      finished_at: (/* @__PURE__ */ new Date()).toISOString(),
      message: errorMessage(e)
    }).eq("id", id);
    throw e;
  }
}
var endpointRegistered = false;
async function registerEndpoint(db) {
  const url = Deno.env.get("SUPABASE_URL");
  if (endpointRegistered || !url) return;
  const { error } = await db.rpc("castor_register_endpoint", {
    p_url: `${url.replace(/\/+$/, "")}/functions/v1`
  });
  if (error) console.error("castor-jobs : enregistrement de l\u2019adresse des fonctions :", error.message);
  else endpointRegistered = true;
}
async function handle(req) {
  if (req.method === "OPTIONS") return new Response("ok", {
    headers: corsHeaders
  });
  if (req.method === "GET") return json({
    ok: true,
    service: "castor-jobs",
    core: CORE_VERSION
  });
  if (req.method !== "POST") return json({
    error: "m\xE9thode non autoris\xE9e"
  }, 405);
  let task = "";
  try {
    const body = await req.json().catch(() => ({})) ?? {};
    task = String(body.task ?? "");
    const def = TASKS[task];
    if (!def) throw new HttpError(400, `t\xE2che inconnue : ${task || "(vide)"}`);
    const db = serviceClient();
    const caller = await authenticate(req, db);
    if (caller.trigger === "cron" && !def.cron) throw new HttpError(403, `t\xE2che ${task} non planifiable`);
    if (caller.trigger === "admin") await registerEndpoint(db);
    const now = /* @__PURE__ */ new Date();
    const ctx = {
      db,
      caller,
      body,
      clock: parisClock(now),
      now
    };
    if (caller.trigger === "cron" && def.gate) {
      const reason = await def.gate(ctx);
      if (reason) return json({
        task,
        skipped: reason
      });
    }
    const result = def.log === false ? await def.run(ctx) : await withJobLog(ctx, task, () => def.run(ctx));
    return json({
      task,
      ...result
    });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status >= 500) console.error(`castor-jobs ${task} :`, e);
    return json({
      task,
      error: errorMessage(e)
    }, status);
  }
}

// supabase/functions/castor-jobs/index.ts
Deno.serve(handle);
