// main.js — connects the input panel to the AWV engine and draws the results.
// Flow:  form inputs  ->  readForm()  ->  runForecast()  ->  render cards + table.

import { FREQUENCIES, runForecast, summarise, validateInvestment } from './awv.js';
import { makeShocks } from './rng.js';

const FUND_CODES = ['AGAIF', 'AGDIF'];
const $ = (id) => document.getElementById(id);

let plan, fundData; // loaded from data/*.json

// Starting values: these mirror the notebook (cells 2, 4, 13).
const DEFAULTS = {
  age: 57, gender: 'Male',
  premium: 10000, frequency: 'Annual',
  premiumYears: 8, projectionYears: 43, reinvestYears: 10,
  weight: 100, horizon: '1y',
  distribution: 'normal', seed: 42,
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
const money = (n, d = 2) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const num = (el, fallback) => {
  const v = parseFloat(el.value);
  return Number.isFinite(v) ? v : fallback;
};
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

// Pairs of [form field id, URL key] used to save/restore a scenario in the page address.
const URL_KEYS = {
  age: 'age', gender: 'sex', premium: 'prem', frequency: 'freq', premiumYears: 'py',
  projectionYears: 'yrs', reinvestYears: 'ry', weight: 'w', horizon: 'h',
  distribution: 'dist', seed: 'seed',
};
const ASSUMPTION_KEYS = FUND_CODES.flatMap((c) => ['mu', 'sigma', 'div'].map((k) => `${c}-${k}`));

// ---------------------------------------------------------------------------
// Form <-> defaults
// ---------------------------------------------------------------------------
function setField(id, value) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = !!value;
  else el.value = value;
}

// Fill return / volatility / dividend boxes from the fund data for the chosen window.
function applyHistoricalAssumptions() {
  const horizon = $('horizon').value;
  for (const code of FUND_CODES) {
    const f = fundData.funds[code];
    const h = f.horizons[horizon];
    setField(`${code}-mu`, +(h.return * 100).toFixed(2));
    setField(`${code}-sigma`, +(h.vol * 100).toFixed(2));
    setField(`${code}-div`, f.latestDividend);
    $(`${code}-price`).textContent = `Latest NAV ${f.latestPrice.toFixed(4)} · data as of ${fundData.asOf}`;
  }
}

function loadFromUrl() {
  const q = new URLSearchParams(location.search);
  for (const [id, key] of Object.entries(URL_KEYS)) {
    if (!q.has(key)) continue;
    const raw = q.get(key);
    const el = $(id);
    if (el.type === 'checkbox') el.checked = raw === '1';
    else el.value = raw;
  }
}

function loadAssumptionsFromUrl() {
  const q = new URLSearchParams(location.search);
  for (const id of ASSUMPTION_KEYS) if (q.has(id)) $(id).value = q.get(id);
}

function saveToUrl() {
  const q = new URLSearchParams();
  for (const [id, key] of Object.entries(URL_KEYS)) {
    const el = $(id);
    q.set(key, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
  }
  for (const id of ASSUMPTION_KEYS) q.set(id, $(id).value);
  try { history.replaceState(null, '', '?' + q.toString()); } catch { /* ignore (e.g. file://) */ }
}

// ---------------------------------------------------------------------------
// Read the form into a plain object
// ---------------------------------------------------------------------------
function readForm() {
  const projectionYears = clamp(Math.round(num($('projectionYears'), DEFAULTS.projectionYears)), 1, 60);
  const weightAGAIF = clamp(num($('weight'), DEFAULTS.weight), 0, 100) / 100;
  const weights = { AGAIF: weightAGAIF, AGDIF: 1 - weightAGAIF };

  const funds = {};
  for (const code of FUND_CODES) {
    const f = fundData.funds[code];
    funds[code] = {
      weight: weights[code],
      mu: num($(`${code}-mu`), 0) / 100,
      sigma: Math.max(num($(`${code}-sigma`), 0), 0) / 100,
      dividend: Math.max(num($(`${code}-div`), 0), 0),
      price: f.latestPrice,
    };
  }

  return {
    client: {
      entryAge: clamp(Math.round(num($('age'), DEFAULTS.age)), 0, 99),
      gender: $('gender').value,
    },
    investment: {
      annualPremium: Math.max(num($('premium'), 0), 0),
      paymentFrequency: $('frequency').value,
      premiumPaymentYears: clamp(Math.round(num($('premiumYears'), 8)), 1, 8),
      projectionYears,
      yearsToReinvest: clamp(Math.round(num($('reinvestYears'), 0)), 0, projectionYears),
    },
    funds,
    distribution: $('distribution').value,
    seed: Math.max(Math.round(num($('seed'), DEFAULTS.seed)), 0),
    horizon: $('horizon').value,
  };
}

// ---------------------------------------------------------------------------
// Drawing
// ---------------------------------------------------------------------------
function renderCards(s, inputs) {
  const cards = [
    { k: `Value at age ${s.finalAge}`, v: money(s.finalTav, 0) },
    { k: 'Premiums paid', v: money(s.premiumsPaid, 0) },
    { k: 'Dividends withdrawn', v: money(s.withdrawals, 0) },
    { k: 'Total fees & charges', v: money(s.fees, 0) },
  ];
  if (s.topups > 0) {
    cards.push({
      k: `Top-ups needed (from year ${s.firstTopupYear})`, v: money(s.topups, 0), warn: true,
    });
  }
  $('cards').innerHTML = cards
    .map((c) => `<div class="card${c.warn ? ' warn' : ''}"><div class="k">${c.k}</div><div class="v">${c.v}</div></div>`)
    .join('');
}

function renderTable(rows, inputs) {
  const active = FUND_CODES.filter((c) => inputs.funds[c].weight > 0);
  const m = (fn) => (r) => money(fn(r));

  const cols = [
    ['Year', (r) => r.policyYear, 'txt'],
    ['Age', (r) => r.age, 'txt'],
    ...active.map((c) => [`${c} NAV (start)`, m((r) => r.navBeg[c])]),
    ['Value (start)', m((r) => r.totalTavBeg)],
    ['Welcome bonus', m((r) => r.welcomeBonus)],
    ['Investment bonus', m((r) => r.investmentBonus)],
    ['Performance bonus', m((r) => r.performanceBonus)],
    ['Contribution + bonuses', m((r) => r.contributionAftBonuses)],
    ['Dividends', (r) => r.decision, 'txt'],
    ['Withdrawal', m((r) => r.withdrawal)],
    ['Withdrawal charge', m((r) => r.partialWithdrawalCharge)],
    ['Supplementary charge', m((r) => r.supplementaryCharge)],
    ['Benefit charge', m((r) => r.benefitCharge)],
    ['Total fees & charges', m((r) => r.totalFees)],
    ['Top-up required', m((r) => r.topupRequired)],
    ...active.map((c) => [`${c} units (end)`, (r) => r.unitsEnd[c].toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })]),
    ...active.map((c) => [`${c} value (end)`, m((r) => r.tavEnd[c])]),
    ['Total value (end)', m((r) => r.totalTavEnd)],
  ];

  const head = '<thead><tr>' + cols.map((c) => `<th>${c[0]}</th>`).join('') + '</tr></thead>';
  const body =
    '<tbody>' +
    rows
      .map((r) => {
        const cls = [r.fundSufficient ? '' : 'topup', r.decision === 'Withdraw' ? 'withdraw' : ''].join(' ').trim();
        return `<tr class="${cls}">` + cols.map((c) => `<td${c[2] ? ` class="${c[2]}"` : ''}>${c[1](r)}</td>`).join('') + '</tr>';
      })
      .join('') +
    '</tbody>';
  $('forecast').innerHTML = head + body;
}

function setMsg(id, text, kind) {
  const el = $(id);
  el.textContent = text || '';
  el.className = 'msg' + (kind ? ' ' + kind : '');
}

// ---------------------------------------------------------------------------
// Main update: runs on every input change
// ---------------------------------------------------------------------------
function update() {
  const inputs = readForm();
  const { investment } = inputs;

  // Slider labels and limits
  $('reinvestYears').max = investment.projectionYears;
  $('premiumYears-out').textContent = investment.premiumPaymentYears;
  $('projectionYears-out').textContent = `${investment.projectionYears} (to age ${inputs.client.entryAge + investment.projectionYears - 1})`;
  $('reinvestYears-out').textContent = investment.yearsToReinvest;
  $('weight-out').textContent = `${Math.round(inputs.funds.AGAIF.weight * 100)}% / AGDIF ${Math.round(inputs.funds.AGDIF.weight * 100)}%`;
  $('fund-AGAIF').style.opacity = inputs.funds.AGAIF.weight > 0 ? 1 : 0.5;
  $('fund-AGDIF').style.opacity = inputs.funds.AGDIF.weight > 0 ? 1 : 0.5;

  // Warn when the chosen history window has no data for a fund in use
  const noData = FUND_CODES.filter((c) => {
    const h = fundData.funds[c].horizons[inputs.horizon];
    return inputs.funds[c].weight > 0 && h.return === 0 && h.vol === 0;
  });
  setMsg(
    'horizon-msg',
    noData.length
      ? `${noData.join(', ')} has no ${inputs.horizon} history in the notebook data, so its default return and volatility are 0. Type your own values below.`
      : '',
    'warn'
  );

  // Premium validation (replaces AWV_validate_investment)
  const check = validateInvestment(plan, investment.paymentFrequency, investment.annualPremium);
  setMsg('premium-msg', check.message, check.ok ? 'good' : 'bad');
  const err = $('error');
  if (!check.ok) {
    err.textContent = check.message + ' Increase the premium or choose a more frequent plan.';
    err.hidden = false;
    $('cards').innerHTML = '';
    $('forecast').innerHTML = '';
    saveToUrl();
    return;
  }
  err.hidden = true;

  // Run the forecast
  const shocks = makeShocks(FUND_CODES, investment.projectionYears, inputs.seed, inputs.distribution);
  const rows = runForecast(plan, { ...inputs, shocks });

  renderCards(summarise(rows), inputs);
  renderTable(rows, inputs);
  saveToUrl();
}

// Run at most once per animation frame so dragging a slider stays smooth.
let queued = false;
function scheduleUpdate() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => { queued = false; update(); });
}

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------
async function init() {
  try {
    const [p, f] = await Promise.all([
      fetch('data/awv_plan.json').then((r) => r.json()),
      fetch('data/funds.json').then((r) => r.json()),
    ]);
    plan = p;
    fundData = f;
  } catch (e) {
    const err = $('error');
    err.hidden = false;
    err.textContent =
      'Could not load data files. If you opened index.html directly from your computer, ' +
      'browsers block that. Use the GitHub Pages address or a local web server instead.';
    return;
  }

  $('frequency').innerHTML = FREQUENCIES.map((f) => `<option>${f}</option>`).join('');
  for (const [id, v] of Object.entries(DEFAULTS)) setField(id, v);
  loadFromUrl();                // scenario saved in the page address (if any)
  applyHistoricalAssumptions(); // fill return/vol/dividend for the chosen window...
  loadAssumptionsFromUrl();     // ...then let any saved edits win

  document.querySelectorAll('.panel input, .panel select').forEach((el) => {
    el.addEventListener('input', scheduleUpdate);
    el.addEventListener('change', scheduleUpdate);
  });
  // Changing the history window refills the return/volatility boxes.
  $('horizon').addEventListener('change', () => { applyHistoricalAssumptions(); scheduleUpdate(); });
  $('reset-assumptions').addEventListener('click', () => { applyHistoricalAssumptions(); scheduleUpdate(); });
  $('new-path').addEventListener('click', () => {
    $('seed').value = Math.floor(Math.random() * 1_000_000);
    scheduleUpdate();
  });

  update();
}

init();
