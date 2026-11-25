// montecarlo.js — run the forecast many times with different random paths, then
// summarise across trials (notebook cell 19: run_monte_carlo).
// Pure logic, no DOM, so it runs both in the Web Worker and in tests.

import { runForecast } from './awv.js';

// Percentile of an already-sorted array, using linear interpolation between
// neighbours (the same method as numpy.percentile). p is 0..100.
export function percentileSorted(sorted, p) {
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, n - 1);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// inputs      = same object runForecast takes, but without `shocks`
// nextShocks  = function returning a fresh { fundCode: [shock per year] } each call
// onProgress  = optional callback(fraction 0..1)
export function runMonteCarlo(plan, inputs, nTrials, nextShocks, onProgress) {
  const years = inputs.investment.projectionYears;

  // One typed array per policy year, holding that year's value for every trial.
  // (Year-major, so we can sort one year at a time.)
  const mk = () => Array.from({ length: years }, () => new Float64Array(nTrials));
  const tav = mk(), fee = mk(), supp = mk(), ben = mk();
  let trialsNeedingTopup = 0;
  const firstTopupInYear = new Array(years).fill(0); // trials whose FIRST top-up falls in year y

  const progressEvery = Math.max(1, Math.floor(nTrials / 50));
  for (let i = 0; i < nTrials; i++) {
    const rows = runForecast(plan, { ...inputs, shocks: nextShocks() });
    let firstTopup = -1;
    for (let y = 0; y < years; y++) {
      const r = rows[y];
      tav[y][i] = r.totalTavEnd;
      fee[y][i] = r.totalFees;
      supp[y][i] = r.supplementaryCharge;
      ben[y][i] = r.benefitCharge;
      if (!r.fundSufficient && firstTopup < 0) firstTopup = y;
    }
    if (firstTopup >= 0) { trialsNeedingTopup++; firstTopupInYear[firstTopup]++; }
    if (onProgress && (i + 1) % progressEvery === 0) onProgress((i + 1) / nTrials);
  }

  const finalTavs = Float64Array.from(tav[years - 1]); // keep a copy: sorting below reorders it

  // Per-year percentiles across all trials (sorting each year's array in place).
  const stat = (arrs, ps) => {
    const out = ps.map(() => new Array(years));
    for (let y = 0; y < years; y++) {
      arrs[y].sort();
      ps.forEach((p, k) => { out[k][y] = percentileSorted(arrs[y], p); });
    }
    return out;
  };
  const [tavP5, tavMed, tavP95] = stat(tav, [5, 50, 95]);
  const [feeP5, feeMed, feeP95] = stat(fee, [5, 50, 95]);
  const [suppMed] = stat(supp, [50]);
  const [benMed] = stat(ben, [50]);

  // Running total: how many trials have needed a top-up by the end of each policy year.
  const topupCumulative = [];
  firstTopupInYear.reduce((run, n) => { topupCumulative.push(run + n); return run + n; }, 0);

  const ages = Array.from({ length: years }, (_, t) => inputs.client.entryAge + t);
  return {
    n: nTrials, ages, finalTavs, trialsNeedingTopup, topupCumulative,
    tavP5, tavMed, tavP95, feeP5, feeMed, feeP95, suppMed, benMed,
  };
}
