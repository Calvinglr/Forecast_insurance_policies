// main.js — connects the input panel to the AWV engine and draws the results.
//
//   form inputs -> readForm() -> runForecast()   -> sample-path table   (instant)
//                            \-> Web Worker      -> Monte Carlo charts  (after a short pause)

import { FREQUENCIES, runForecast, summarise, validateInvestment } from './awv.js';
import { makeTrialShocks } from './rng.js';
import { drawAll, clearAll, drawDepletion } from './charts.js';
import { buildCells, renderSensitivity, renderLegend } from './sensitivity.js';
import { buildWithdrawalCells, depletionSeries, RISK_THRESHOLD } from './withdrawal.js';

const FUND_CODES = ['AGAIF', 'AGDIF'];
const $ = (id) => document.getElementById(id);

let plan, fundData; // loaded from data/*.json

// Starting values: these mirror the notebook (cells 2, 4, 13).
const DEFAULTS = {
  age: 57, gender: 'Male',
  premium: 10000, frequency: 'Annual',
  premiumYears: 8, endAge: 100, reinvestYears: 10,
  weight: 100, horizon: '1y',
  distribution: 'normal', trials: 10000, seed: 42,
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

// Form field id -> short key used to save/restore a scenario in the page address.
const URL_KEYS = {
  age: 'age', gender: 'sex', premium: 'prem', frequency: 'freq', premiumYears: 'py',
  endAge: 'end', reinvestYears: 'ry', weight: 'w', horizon: 'h',
  distribution: 'dist', trials: 'n', seed: 'seed',
};
const ASSUMPTION_KEYS = FUND_CODES.flatMap((c) => ['mu', 'sigma', 'div'].map((k) => `${c}-${k}`));

// ---------------------------------------------------------------------------
// Form <-> defaults <-> URL
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
    if (q.has(key)) $(id).value = q.get(key);
  }
}
function loadAssumptionsFromUrl() {
  const q = new URLSearchParams(location.search);
  for (const id of ASSUMPTION_KEYS) if (q.has(id)) $(id).value = q.get(id);
}
function saveToUrl() {
  const q = new URLSearchParams();
  for (const [id, key] of Object.entries(URL_KEYS)) q.set(key, $(id).value);
  for (const id of ASSUMPTION_KEYS) q.set(id, $(id).value);
  try { history.replaceState(null, '', '?' + q.toString()); } catch { /* ignore (e.g. file://) */ }
}

// ---------------------------------------------------------------------------
// Read the form into a plain object
// ---------------------------------------------------------------------------
function readForm() {
  // The user picks the age to calculate until; the number of policy years follows from it.
  const entryAge = clamp(Math.round(num($('age'), DEFAULTS.age)), 0, 99);
  const endAge = clamp(Math.round(num($('endAge'), DEFAULTS.endAge)), entryAge, 100);
  const projectionYears = endAge - entryAge + 1;
  const weightAGAIF = clamp(num($('weight'), DEFAULTS.weight), 0, 100) / 100;
  const weights = { AGAIF: weightAGAIF, AGDIF: 1 - weightAGAIF };

  const funds = {};
  for (const code of FUND_CODES) {
    funds[code] = {
      weight: weights[code],
      mu: num($(`${code}-mu`), 0) / 100,
      sigma: Math.max(num($(`${code}-sigma`), 0), 0) / 100,
      dividend: Math.max(num($(`${code}-div`), 0), 0),
      price: fundData.funds[code].latestPrice,
    };
  }

  return {
    client: {
      entryAge,
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
    nTrials: clamp(Math.round(num($('trials'), DEFAULTS.trials)), 100, 100000),
    horizon: $('horizon').value,
  };
}

// ---------------------------------------------------------------------------
// Summary cards, table, messages
// ---------------------------------------------------------------------------
let lastRows = null;  // the sample path
let lastSim = null;   // the latest finished Monte Carlo (or null while running)

function renderCards() {
  if (!lastRows) { $('cards').innerHTML = ''; return; }
  const premiums = summarise(lastRows).premiumsPaid;
  const age = lastRows[lastRows.length - 1].age;
  const pending = '…';
  const sim = lastSim;
  const cards = [
    { k: `Median value at age ${age}`, v: sim ? money(sim.tavMed.at(-1), 0) : pending },
    { k: '5th percentile (bad case)', v: sim ? money(sim.tavP5.at(-1), 0) : pending },
    { k: '95th percentile (good case)', v: sim ? money(sim.tavP95.at(-1), 0) : pending },
    { k: 'Premiums paid', v: money(premiums, 0) },
  ];
  if (sim && sim.trialsNeedingTopup > 0) {
    const pct = (100 * sim.trialsNeedingTopup) / sim.n;
    cards.push({
      k: 'Trials where fees outrun the account (top-up needed)',
      v: `${pct < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`, warn: true,
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
// Monte Carlo: runs in a Web Worker so the page never freezes
// ---------------------------------------------------------------------------
const chartEls = {
  hist: $('chart-hist'), tav: $('chart-tav'), surrender: $('chart-surrender'),
  fees: $('chart-fees'), breakdown: $('chart-breakdown'),
};
let worker = null;
let simTimer = null;

function stopWorker() {
  clearTimeout(simTimer);
  if (worker) { worker.terminate(); worker = null; }
}

function setStatus(text, { progress = null, isError = false } = {}) {
  const box = $('sim-status');
  box.hidden = !text;
  box.classList.toggle('error-text', isError);
  $('sim-text').textContent = text || '';
  $('sim-progress').hidden = progress === null;
  if (progress !== null) $('sim-progress').value = progress;
}

function startSimulation(inputs) {
  stopWorker();
  const t0 = performance.now();
  setStatus(`Running ${inputs.nTrials.toLocaleString()} trials…`, { progress: 0 });

  try {
    worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  } catch (e) {
    setStatus('This browser could not start the background simulation.', { isError: true });
    return;
  }
  const mine = worker; // ignore messages from a worker we have since replaced
  worker.onmessage = (event) => {
    if (worker !== mine) return;
    const msg = event.data;
    if (msg.type === 'progress') {
      setStatus(`Running ${inputs.nTrials.toLocaleString()} trials… ${Math.round(msg.fraction * 100)}%`, { progress: msg.fraction });
    } else if (msg.type === 'done') {
      lastSim = msg.result;
      $('charts').classList.remove('stale');
      const plotlyOk = typeof Plotly !== 'undefined';
      const extras = chartExtras();
      if (plotlyOk) drawAll(chartEls, lastSim, extras);
      updateSurrenderNote(lastSim, extras);
      renderCards();
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      setStatus(
        `${lastSim.n.toLocaleString()} trials in ${secs} s` +
          (plotlyOk ? '' : ' · charts unavailable: js/plotly.min.js did not load'),
        { isError: !plotlyOk }
      );
      mine.terminate();
      worker = null;
    } else if (msg.type === 'error') {
      setStatus('Simulation failed: ' + msg.message, { isError: true });
    }
  };
  worker.onerror = (e) => {
    if (worker !== mine) return;
    setStatus('Simulation failed to start. If you opened the page from your computer, use the GitHub Pages address instead.', { isError: true });
  };

  const { seed, nTrials, ...forecastInputs } = inputs;
  worker.postMessage({
    plan, inputs: forecastInputs, nTrials, seed, fundCodes: FUND_CODES,
  });
}

// ---------------------------------------------------------------------------
// Sensitivity analysis: one simulation for every (return, volatility) pair in the grid
// ---------------------------------------------------------------------------
let lastInputs = null;  // the inputs behind lastRows (null when the inputs are invalid)
let sensGrid = null;    // finished results, or null
let sensWorkers = [];   // running background workers (empty when idle)
let sensRunKey = null;  // sensKeyOf() of the inputs the current run was started with

// Everything that changes the grid EXCEPT each fund's return and volatility (the grid replaces those).
function sensKeyOf(inputs) {
  const funds = {};
  for (const [code, f] of Object.entries(inputs.funds)) funds[code] = { weight: f.weight, dividend: f.dividend, price: f.price };
  return JSON.stringify({
    client: inputs.client, investment: inputs.investment, funds,
    distribution: inputs.distribution, seed: inputs.seed,
  });
}

function setSensStatus(text, { progress = null, isError = false } = {}) {
  const box = $('sens-status');
  box.hidden = !text;
  box.classList.toggle('error-text', isError);
  $('sens-text').textContent = text || '';
  $('sens-progress').hidden = progress === null;
  if (progress !== null) $('sens-progress').value = progress;
}

function stopSensitivity() {
  sensWorkers.forEach((w) => w.terminate());
  sensWorkers = [];
  $('sens-run').disabled = !lastInputs;
}

// Redraw the table from stored results (no re-simulation: changing the metric or age is instant).
function renderSens() {
  const has = !!sensGrid;
  $('sens-empty').hidden = has;
  $('sens-legend').hidden = !has;
  $('sens-age').disabled = !has;
  if (!has) {
    $('sens-table').innerHTML = '';
    $('sens-note').textContent = '';
    $('sens-age').innerHTML = '';
    $('sens-stale').hidden = true;
    $('sens-wrap').classList.remove('stale');
    return;
  }

  // "At age" choices: every 5th age, plus the final age. Keep the user's choice if still available.
  const ages = sensGrid.ages;
  const last = ages[ages.length - 1];
  const choices = ages.filter((a) => a % 5 === 0 || a === last);
  const select = $('sens-age');
  const previous = Number(select.value);
  select.innerHTML = choices.map((a) => `<option value="${a}">${a}</option>`).join('');
  select.value = String(choices.includes(previous) ? previous : last);

  const metric = $('sens-metric').value;
  renderSensitivity($('sens-table'), sensGrid, { metric, yearIndex: ages.indexOf(Number(select.value)) });
  renderLegend($('sens-legend'), metric);
  $('sens-note').textContent =
    `Each cell is ${sensGrid.n.toLocaleString()} trials (seed ${sensGrid.seed}). Return is the annual price return before ` +
    'dividends, and return and volatility are applied to every fund in your mix. Colours compare the value with the ' +
    'premiums paid in by that age. Hover or tap a cell for the exact figure.';
}

// Grey the table out when the inputs no longer match the ones it was calculated with.
function checkSensStale() {
  const stale = !!sensGrid && !!lastInputs && sensGrid.key !== sensKeyOf(lastInputs);
  $('sens-wrap').classList.toggle('stale', stale);
  $('sens-stale').hidden = !stale;
}

function startSensitivity() {
  if (!lastInputs || !lastRows) return;
  stopSensitivity();
  const inputs = lastInputs;
  sensRunKey = sensKeyOf(inputs);
  const nTrials = Number($('sens-trials').value);
  const cells = buildCells();
  const workerCount = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2, cells.length));
  const { seed, nTrials: _mainTrials, horizon, ...forecastInputs } = inputs;
  const results = {};
  const t0 = performance.now();
  $('sens-run').disabled = true;
  setSensStatus(`Running ${cells.length} simulations of ${nTrials.toLocaleString()} trials…`, { progress: 0 });

  const fail = (message) => {
    stopSensitivity();
    setSensStatus(message, { isError: true });
  };

  for (let i = 0; i < workerCount; i++) {
    let w;
    try {
      w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      fail('This browser could not start background workers.');
      return;
    }
    sensWorkers.push(w);
    w.onmessage = (event) => {
      if (!sensWorkers.includes(w)) return; // from a run we have since cancelled
      const msg = event.data;
      if (msg.type === 'cell') {
        results[msg.key] = msg.result;
        const done = Object.keys(results).length;
        setSensStatus(`Running ${cells.length} simulations of ${nTrials.toLocaleString()} trials… ${done}/${cells.length}`, { progress: done / cells.length });
        if (done === cells.length) {
          let paid = 0;
          sensGrid = {
            cells: results, n: nTrials, seed, key: sensKeyOf(inputs),
            ages: lastRows.map((r) => r.age),
            cumPremiums: lastRows.map((r) => (paid += r.contribution)),
          };
          stopSensitivity();
          setSensStatus(`${cells.length} simulations × ${nTrials.toLocaleString()} trials in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
          renderSens();
          checkSensStale();
        }
      } else if (msg.type === 'error') {
        fail('Sensitivity analysis failed: ' + msg.message);
      }
    };
    w.onerror = () => fail('Sensitivity analysis failed to start. If you opened the page from your computer, use the GitHub Pages address instead.');
    w.postMessage({
      type: 'cells', plan, inputs: forecastInputs, nTrials, seed, fundCodes: FUND_CODES,
      cells: cells.filter((_, j) => j % workerCount === i),
    });
  }
}

// ---------------------------------------------------------------------------
// Run a list of grid cells (see worker.js) across a few background workers.
// Returns a handle: handle.stop() cancels everything.
// ---------------------------------------------------------------------------
function runCellJobs({ cells, inputs, nTrials, seed, onCell, onDone, onFail }) {
  const workers = [];
  const handle = { stop() { workers.forEach((w) => w.terminate()); workers.length = 0; } };
  const count = Math.max(1, Math.min(4, navigator.hardwareConcurrency || 2, cells.length));
  let received = 0;
  for (let i = 0; i < count; i++) {
    let w;
    try {
      w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    } catch (e) {
      handle.stop();
      onFail('This browser could not start background workers.');
      return handle;
    }
    workers.push(w);
    w.onmessage = (event) => {
      if (!workers.includes(w)) return; // from a run we have since cancelled
      const msg = event.data;
      if (msg.type === 'cell') {
        received++;
        onCell(msg.key, msg.result, received);
        if (received === cells.length) { handle.stop(); onDone(); }
      } else if (msg.type === 'error') {
        handle.stop();
        onFail('Failed: ' + msg.message);
      }
    };
    w.onerror = () => {
      if (!workers.includes(w)) return;
      handle.stop();
      onFail('Failed to start. If you opened the page from your computer, use the GitHub Pages address instead.');
    };
    w.postMessage({
      type: 'cells', plan, inputs, nTrials, seed, fundCodes: FUND_CODES,
      cells: cells.filter((_, j) => j % count === i),
    });
  }
  return handle;
}

// ---------------------------------------------------------------------------
// Withdrawal analysis: probability of account depletion at different withdrawal rates
// ---------------------------------------------------------------------------
let depGrid = null;   // finished results, or null
let depRun = null;    // handle of the running analysis, or null when idle
let depRunKey = null; // depKeyOf() of the inputs the running analysis started with

// Everything that changes this analysis (unlike the sensitivity table, fund returns DO matter here).
function depKeyOf(inputs) {
  return JSON.stringify({
    client: inputs.client, investment: inputs.investment, funds: inputs.funds,
    distribution: inputs.distribution, seed: inputs.seed,
  });
}
// Withdrawals begin the year after the "reinvest dividends through year N" setting.
const depStartYear = (inputs) => inputs.investment.yearsToReinvest + 1;
const depPossible = (inputs) => depStartYear(inputs) <= inputs.investment.projectionYears;

function setDepStatus(text, { progress = null, isError = false } = {}) {
  const box = $('dep-status');
  box.hidden = !text;
  box.classList.toggle('error-text', isError);
  $('dep-text').textContent = text || '';
  $('dep-progress').hidden = progress === null;
  if (progress !== null) $('dep-progress').value = progress;
}

function stopDepletion() {
  if (depRun) depRun.stop();
  depRun = null;
  $('dep-run').disabled = !(lastInputs && depPossible(lastInputs));
}

function renderDepletion() {
  const el = $('chart-depletion');
  const has = !!depGrid;
  $('dep-empty').hidden = has;
  if (!has) {
    if (typeof Plotly !== 'undefined') { try { Plotly.purge(el); } catch { /* never drawn */ } }
    el.innerHTML = '';
    $('dep-note').textContent = '';
    $('dep-stale').hidden = true;
    $('dep-wrap').classList.remove('stale');
    return;
  }
  const data = depletionSeries(depGrid);
  if (typeof Plotly !== 'undefined') {
    drawDepletion(el, data, { startAge: depGrid.startAge, n: depGrid.n, threshold: RISK_THRESHOLD });
  }
  const pct = (x) => `${Math.round(x * 100)}%`;
  const verdict =
    data.sustainable === null
      ? `Even with no withdrawals, more than ${pct(RISK_THRESHOLD)} of trials run out of money by age ${data.finalAge}.`
      : `The highest rate here with at most a ${pct(RISK_THRESHOLD)} chance of depletion by age ${data.finalAge} is ${pct(data.sustainable)}` +
        (data.sustainable === data.rates[data.rates.length - 1] ? ' (the top of the range).' : '.');
  $('dep-note').textContent =
    `Withdrawals start at age ${depGrid.startAge}: each year you withdraw the rate × the account value on that day, as a fixed dollar ` +
    `amount with no inflation increase, and dividends are reinvested. Depleted = the account can no longer pay the withdrawal and ` +
    `charges. Each point is ${depGrid.n.toLocaleString()} trials (seed ${depGrid.seed}), using your current fund assumptions. ${verdict}`;
}

function checkDepStale() {
  const stale = !!depGrid && !!lastInputs && depGrid.key !== depKeyOf(lastInputs);
  $('dep-wrap').classList.toggle('stale', stale);
  $('dep-stale').hidden = !stale;
}

function refreshDepInfo(inputs) {
  if (depPossible(inputs)) {
    const startYear = depStartYear(inputs);
    $('dep-info').textContent =
      `Withdrawals would start at age ${inputs.client.entryAge + startYear - 1} (policy year ${startYear}), ` +
      `the year after your "Reinvest dividends through year ${inputs.investment.yearsToReinvest}" setting.`;
  } else {
    $('dep-info').textContent =
      'There is no withdrawal period in this projection. Lower "Reinvest dividends through year" below the end age to analyse withdrawals.';
  }
  $('dep-run').disabled = !!depRun || !depPossible(inputs);
}

function startDepletion() {
  if (!lastInputs || !lastRows || !depPossible(lastInputs)) return;
  stopDepletion();
  const inputs = lastInputs;
  const key = depKeyOf(inputs);
  depRunKey = key;
  const startYear = depStartYear(inputs);
  const nTrials = Number($('dep-trials').value);
  const cells = buildWithdrawalCells(startYear);
  const { seed, nTrials: _mainTrials, horizon, ...forecastInputs } = inputs;
  const results = {};
  const ages = lastRows.map((r) => r.age);
  const t0 = performance.now();
  $('dep-run').disabled = true;
  setDepStatus(`Running ${cells.length} simulations of ${nTrials.toLocaleString()} trials…`, { progress: 0 });

  depRun = runCellJobs({
    cells, inputs: forecastInputs, nTrials, seed,
    onCell: (cellKey, result, done) => {
      results[cellKey] = result;
      setDepStatus(`Running ${cells.length} simulations of ${nTrials.toLocaleString()} trials… ${done}/${cells.length}`, { progress: done / cells.length });
    },
    onDone: () => {
      depGrid = { cells: results, n: nTrials, seed, key, ages, startAge: inputs.client.entryAge + startYear - 1 };
      depRun = null;
      setDepStatus(`${cells.length} simulations × ${nTrials.toLocaleString()} trials in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      renderDepletion();
      checkDepStale();
      refreshDepInfo(lastInputs || inputs);
    },
    onFail: (message) => {
      depRun = null;
      setDepStatus('Withdrawal analysis. ' + message, { isError: true });
      refreshDepInfo(lastInputs || inputs);
    },
  });
}

// ---------------------------------------------------------------------------
// Surrender-value chart helpers
// ---------------------------------------------------------------------------
// Cumulative premiums and the full-surrender charge factor for each policy year.
function chartExtras() {
  let paid = 0;
  return {
    cumPremiums: lastRows.map((r) => (paid += r.contribution)),
    surrenderFactors: lastRows.map((r) => plan.fullSurrenderCharge[String(r.policyYear)] ?? 0),
  };
}

function updateSurrenderNote(sim, extras) {
  const surrender = sim.tavMed.map((v, i) => v * (1 - extras.surrenderFactors[i]));
  const firstAge = (series) => {
    const i = series.findIndex((v, k) => extras.cumPremiums[k] > 0 && v >= extras.cumPremiums[k]);
    return i < 0 ? 'never within the projection' : `age ${sim.ages[i]}`;
  };
  const pct = (y) => `${Math.round((plan.fullSurrenderCharge[String(y)] ?? 0) * 100)}%`;
  $('surrender-note').textContent =
    `Surrender value = account value × (1 − full-surrender charge). The charge is ${pct(1)} in year 1, falling to ${pct(10)} in year 10, ` +
    `and 0% from year 11. Median account value first reaches the premiums paid at ${firstAge(sim.tavMed)}; median surrender value at ${firstAge(surrender)}.`;
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
  $('endAge').min = inputs.client.entryAge;
  $('endAge-out').textContent = `${inputs.client.entryAge + investment.projectionYears - 1} (${investment.projectionYears} year${investment.projectionYears === 1 ? '' : 's'})`;
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
    stopWorker();
    err.textContent = check.message + ' Increase the premium or choose a more frequent plan.';
    err.hidden = false;
    lastRows = null; lastSim = null; lastInputs = null;
    sensGrid = null;
    stopSensitivity();
    setSensStatus('');
    renderSens();
    depGrid = null;
    stopDepletion();
    setDepStatus('');
    renderDepletion();
    $('dep-info').textContent = '';
    $('surrender-note').textContent = '';
    $('cards').innerHTML = '';
    $('forecast').innerHTML = '';
    clearAll(chartEls);
    setStatus('');
    saveToUrl();
    return;
  }
  err.hidden = true;

  // Sample path = trial 1 of the simulation (first draw from the seeded stream). Instant.
  const shocks = makeTrialShocks(FUND_CODES, investment.projectionYears, inputs.seed, inputs.distribution)();
  lastRows = runForecast(plan, { ...inputs, shocks });
  lastSim = null; // old simulation no longer matches these inputs
  lastInputs = inputs;
  // Cancel a running analysis only if the inputs really changed. (Clicking Run right after typing
  // fires a 'change' event with identical inputs, which must not cancel the run just started.)
  if (sensWorkers.length && sensKeyOf(inputs) !== sensRunKey) {
    stopSensitivity();
    setSensStatus('Inputs changed, so the sensitivity run was cancelled. Press Run to start it again.');
  }
  $('sens-run').disabled = false;
  checkSensStale();
  // Same rule for the withdrawal analysis: cancel only if its inputs really changed.
  if (depRun && depKeyOf(inputs) !== depRunKey) {
    stopDepletion();
    setDepStatus('Inputs changed, so the withdrawal analysis was cancelled. Press Run to start it again.');
  }
  refreshDepInfo(inputs);
  checkDepStale();
  renderCards();
  renderTable(lastRows, inputs);
  saveToUrl();

  // Charts: grey out the old ones and restart the simulation after a short pause,
  // so dragging a slider doesn't launch a run for every tick.
  $('charts').classList.add('stale');
  stopWorker();
  setStatus('Updating simulation…');
  simTimer = setTimeout(() => startSimulation(inputs), 350);
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
  if (typeof Plotly === 'undefined') {
    const err = $('error');
    err.hidden = false;
    err.textContent = 'The chart library (Plotly) did not load, so charts will be missing. Check your internet connection.';
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

  // Sensitivity table controls (they live outside the input panel)
  $('sens-run').addEventListener('click', startSensitivity);
  $('sens-metric').addEventListener('change', renderSens);
  $('sens-age').addEventListener('change', renderSens);
  renderSens();
  $('dep-run').addEventListener('click', startDepletion);
  renderDepletion();

  // Redraw charts when the device switches between light and dark mode.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (lastSim && lastRows && typeof Plotly !== 'undefined') drawAll(chartEls, lastSim, chartExtras());
    if (depGrid) renderDepletion();
  });

  update();
}

init();
