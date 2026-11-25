// sensitivity.js — the colour-coded return-vs-risk table.
//
// The grid is simply: for every (return, volatility) pair, run a Monte Carlo in which every
// fund in your mix earns that return with that volatility. This file holds the grid settings,
// the colour scale, and the code that draws the table. (The simulations run in worker.js.)

// ===========================================================================
// EDIT THESE TWO LISTS to change the table's rows and columns.
// ===========================================================================
// Annual price return (before dividends) — one table row each:
export const SENS_RETURNS = [-0.12, -0.08, -0.04, 0, 0.04, 0.08, 0.12, 0.16, 0.2, 0.24];
// Annual volatility ("risk") — one table column each:
export const SENS_VOLS = [0.02, 0.05, 0.1, 0.15, 0.2];
// ===========================================================================

export const cellKey = (ret, vol) => `${ret}|${vol}`;

// The list of simulations to run, in the form worker.js expects.
export function buildCells() {
  const cells = [];
  for (const mu of SENS_RETURNS) for (const sigma of SENS_VOLS) cells.push({ key: cellKey(mu, sigma), mu, sigma });
  return cells;
}

// What the table can show. `kind: 'value'` is coloured against premiums paid;
// `kind: 'share'` (share of trials needing a top-up) is coloured from 0% to 100%.
export const METRICS = {
  tavMed: { label: 'Median value', word: 'Median', kind: 'value', pick: (c, i) => c.tavMed[i] },
  tavP5: { label: '5th percentile (bad case)', word: '5th percentile', kind: 'value', pick: (c, i) => c.tavP5[i] },
  tavP95: { label: '95th percentile (good case)', word: '95th percentile', kind: 'value', pick: (c, i) => c.tavP95[i] },
  topup: { label: 'Trials needing a top-up', word: 'Trials needing a top-up', kind: 'share', pick: (c, i, n) => c.topupCumulative[i] / n },
};

// ---------------------------------------------------------------------------
// Colour scale: red (bad) -> yellow (break-even) -> green (good)
// ---------------------------------------------------------------------------
// A score `t` runs from -3 to +6. For values, t = log2(value / premiums paid), so
//   -3 = one eighth of what you paid in,  0 = exactly what you paid in (yellow),
//   +2 = 4x,  +4 = 16x,  +6 = 64x or more. The green end is stretched so that returns
//   from about 4% to 12% still look different from one another.
const T_MIN = -3, T_MAX = 6;
const STOPS = [
  [-3, [165, 0, 38]],
  [-1.5, [244, 109, 67]],
  [0, [254, 224, 139]],
  [2, [166, 217, 106]],
  [4, [26, 152, 80]],
  [6, [0, 104, 55]],
];

function colourAt(t) {
  const x = Math.min(Math.max(t, T_MIN), T_MAX);
  for (let i = 1; i < STOPS.length; i++) {
    if (x <= STOPS[i][0]) {
      const [t0, c0] = STOPS[i - 1];
      const [t1, c1] = STOPS[i];
      const f = (x - t0) / (t1 - t0);
      return c0.map((v, k) => Math.round(v + (c1[k] - v) * f));
    }
  }
  return STOPS[STOPS.length - 1][1];
}

// Pick black or white text, whichever has more contrast on this background.
function textOn([r, g, b]) {
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const contrastBlack = (L + 0.05) / 0.05;
  const contrastWhite = 1.05 / (L + 0.05);
  return contrastBlack >= contrastWhite ? '#111111' : '#ffffff';
}

const scoreValue = (value, premiums) => Math.log2(Math.max(value / Math.max(premiums, 1), 0.125));
const scoreShare = (share) => 4 - 7 * share; // 0% of trials = green (+4), 100% = red (-3)

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
export function compactMoney(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e8) return '$' + Math.round(n / 1e6) + 'M';
  if (a >= 1e7) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
  return '$' + Math.round(n);
}
const full = (n) => '$' + Math.round(n).toLocaleString('en-US');
const pct = (x) => `${Math.round(x * 100)}%`;
const pct1 = (x) => (x > 0 && x < 0.01 ? '<1%' : x === 0 ? '0%' : `${Math.round(x * 100)}%`);

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
// grid = { cells: { key: {tavP5, tavMed, tavP95, topupCumulative} }, ages, cumPremiums, n }
export function renderSensitivity(el, grid, { metric, yearIndex }) {
  const m = METRICS[metric];
  const age = grid.ages[yearIndex];
  const premiums = grid.cumPremiums[yearIndex];

  let html = '<table class="sens"><caption class="sr-only">' +
    `${m.label} at age ${age}, by annual return (rows) and volatility (columns)</caption>`;
  html += `<thead><tr><th class="corner" rowspan="2" scope="col">Annual return</th>` +
    `<th colspan="${SENS_VOLS.length}" scope="colgroup">Volatility (risk)</th></tr><tr>` +
    SENS_VOLS.map((v) => `<th scope="col">${pct(v)}</th>`).join('') + '</tr></thead><tbody>';

  for (const ret of SENS_RETURNS) {
    html += `<tr><th scope="row">${pct(ret)}</th>`;
    for (const vol of SENS_VOLS) {
      const cell = grid.cells[cellKey(ret, vol)];
      if (!cell) { html += '<td>…</td>'; continue; }
      const v = m.pick(cell, yearIndex, grid.n);
      const t = m.kind === 'share' ? scoreShare(v) : scoreValue(v, premiums);
      const bg = colourAt(t);
      const label = m.kind === 'share' ? pct1(v) : compactMoney(v);
      const tip =
        `Return ${pct(ret)}, volatility ${pct(vol)} — ${m.word}` +
        (m.kind === 'share'
          ? `: ${(v * 100).toFixed(1)}% of trials needed a top-up by age ${age}`
          : ` at age ${age}: ${full(v)} (${(v / Math.max(premiums, 1)).toFixed(2)}× the ${full(premiums)} paid in)`);
      html += `<td style="background:rgb(${bg});color:${textOn(bg)}" title="${tip}">${label}</td>`;
    }
    html += '</tr>';
  }
  el.innerHTML = html + '</tbody></table>';
}

export function renderLegend(el, metric) {
  const m = METRICS[metric];
  const rgb = (t) => `rgb(${colourAt(t)})`;
  if (m.kind === 'share') {
    const ts = [4, 2, 0, -1.5, -3];
    el.innerHTML =
      `<span class="bar" style="background:linear-gradient(to right, ${ts.map(rgb).join(',')})"></span>` +
      '<span class="ends"><span>0% of trials</span><span>50%</span><span>100% of trials</span></span>';
  } else {
    const ts = [-3, -1.5, 0, 2, 4, 6];
    el.innerHTML =
      `<span class="bar" style="background:linear-gradient(to right, ${ts.map(rgb).join(',')})"></span>` +
      '<span class="ends"><span>⅛ of premiums paid or less</span><span>= premiums paid (break-even)</span><span>64× or more</span></span>';
  }
}
