// charts.js — the four Plotly charts (notebook cells 23, 25, 27, 28).
// `Plotly` is a global, loaded by the <script> tag in index.html.
// Colours come from the CSS variables in style.css so the charts follow light/dark mode.

const BLUE = 'rgb(31,119,180)';
const BLUE_FILL = 'rgba(31,119,180,0.22)';
const RED = 'rgb(214,39,40)';
const RED_FILL = 'rgba(214,39,40,0.22)';
const ORANGE = 'rgb(255,127,14)';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
// The hover toolbar covers the title on phones, so hide it on narrow screens.
const config = () => ({ responsive: true, displaylogo: false, displayModeBar: window.innerWidth > 700 });

// Shared look for every chart.
function baseLayout(title, xTitle, yTitle) {
  const text = cssVar('--text');
  const grid = cssVar('--line');
  return {
    title: { text: title, font: { size: 15, color: text }, x: 0.02, xanchor: 'left' },
    paper_bgcolor: 'rgba(0,0,0,0)',
    plot_bgcolor: 'rgba(0,0,0,0)',
    font: { color: text, size: 12 },
    margin: { l: 64, r: 20, t: 54, b: 56 },
    height: 380,
    xaxis: { title: { text: xTitle }, gridcolor: grid, zerolinecolor: grid },
    yaxis: { title: { text: yTitle }, gridcolor: grid, zerolinecolor: grid, tickformat: '$.3~s', hoverformat: '$,.0f' },
    legend: { orientation: 'h', y: -0.22 },
    // Black text on a white box, so hover details read the same in light and dark mode.
    hoverlabel: { bgcolor: '#ffffff', bordercolor: '#9aa3af', font: { color: '#000000', size: 12 } },
  };
}

// 1. Histogram of the final value, with lines at the 5th / median / 95th percentile.
export function drawHistogram(el, res) {
  const last = res.ages[res.ages.length - 1];
  const marks = [
    ['5th', res.tavP5.at(-1), 'dash'],
    ['Median', res.tavMed.at(-1), 'solid'],
    ['95th', res.tavP95.at(-1), 'dash'],
  ];
  const layout = baseLayout(
    `Final value at age ${last}: ${res.n.toLocaleString()} trials`,
    'Total account value', 'Trials'
  );
  layout.xaxis.tickformat = '$.3~s';
  layout.xaxis.hoverformat = '$,.0f';
  layout.xaxis.nticks = 6;
  layout.yaxis.tickformat = ',d';
  layout.showlegend = false;
  layout.bargap = 0.03;
  layout.shapes = marks.map(([, x, dash]) => ({
    type: 'line', x0: x, x1: x, yref: 'paper', y0: 0, y1: 1,
    line: { color: cssVar('--text'), width: 1.5, dash },
  }));
  layout.annotations = marks.map(([label, x], i) => ({
    x, yref: 'paper', y: 1, yanchor: 'bottom', showarrow: false,
    text: `${label} $${(x / 1e6).toFixed(2)}M`, font: { size: 11 },
    yshift: i === 1 ? 16 : 0,
    xanchor: i === 0 ? 'right' : i === 2 ? 'left' : 'center',
  }));
  layout.margin.t = 84;
  Plotly.react(el, [{
    type: 'histogram', x: res.finalTavs, nbinsx: 40, marker: { color: BLUE },
    hovertemplate: 'Value %{x}<br>Trials %{y}<extra></extra>',
  }], layout, config());
}

// A median line with a shaded 5th-95th percentile band (used for value and fees).
function drawBand(el, { ages, p5, med, p95, color, fill, title, yTitle, medName, label }) {
  const layout = baseLayout(title, 'Age', yTitle);
  layout.hovermode = 'x unified';
  Plotly.react(el, [
    {
      type: 'scatter', mode: 'lines', x: ages.concat([...ages].reverse()), y: p95.concat([...p5].reverse()),
      fill: 'toself', fillcolor: fill, line: { color: 'rgba(0,0,0,0)' },
      hoverinfo: 'skip', name: '5th–95th percentile',
    },
    {
      type: 'scatter', mode: 'lines', x: ages, y: med, name: medName,
      line: { color, width: 2.5 },
      customdata: ages.map((_, i) => [p5[i], p95[i]]),
      hovertemplate:
        `5th: $%{customdata[0]:,.0f}<br>${label}: $%{y:,.0f}<br>95th: $%{customdata[1]:,.0f}<extra></extra>`,
    },
  ], layout, config());
}

// 2. Total account value over time.
export function drawValueBand(el, res) {
  drawBand(el, {
    ages: res.ages, p5: res.tavP5, med: res.tavMed, p95: res.tavP95,
    color: BLUE, fill: BLUE_FILL, medName: 'Median', label: 'Median',
    title: 'Total account value over time',
    yTitle: 'Total account value',
  });
}

// 3. Total fees and charges per policy year.
export function drawFeeBand(el, res) {
  drawBand(el, {
    ages: res.ages, p5: res.feeP5, med: res.feeMed, p95: res.feeP95,
    color: RED, fill: RED_FILL, medName: 'Median fees', label: 'Median',
    title: 'Fees & charges per policy year',
    yTitle: 'Fees & charges per year',
  });
}

// 4. Median supplementary vs benefit charge, by age.
export function drawFeeBreakdown(el, res) {
  const layout = baseLayout(
    'Median fee breakdown by age', 'Age', 'Median charge per year'
  );
  layout.barmode = 'group';
  layout.bargap = 0.15;
  layout.hovermode = 'x unified';
  Plotly.react(el, [
    { type: 'bar', x: res.ages, y: res.suppMed, name: 'Supplementary charge', marker: { color: ORANGE },
      hovertemplate: '$%{y:,.0f}' },
    { type: 'bar', x: res.ages, y: res.benMed, name: 'Benefit charge', marker: { color: RED },
      hovertemplate: '$%{y:,.0f}' },
  ], layout, config());
}

export function drawAll(els, res) {
  drawHistogram(els.hist, res);
  drawValueBand(els.tav, res);
  drawFeeBand(els.fees, res);
  drawFeeBreakdown(els.breakdown, res);
}

export function clearAll(els) {
  for (const el of Object.values(els)) {
    try { Plotly.purge(el); } catch { /* chart was never drawn */ }
    el.innerHTML = '';
  }
}
