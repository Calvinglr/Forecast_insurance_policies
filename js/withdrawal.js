// withdrawal.js — settings and helpers for the "probability of account depletion" analysis.
//
// For each withdrawal rate below we run a Monte Carlo in which, from the start year, you withdraw
// (rate x account value on that day) every year, as a fixed dollar amount. The simulation itself
// runs in worker.js, using the `withdrawalPlan` option in awv.js. This file builds the list of
// jobs and turns the finished results into chart-ready numbers.

// ===========================================================================
// EDIT THESE to change the chart's x-axis or the "acceptable risk" line.
// ===========================================================================
// Annual withdrawal rates to test, as a share of the account value when withdrawals start:
export const WITHDRAWAL_RATES = [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.1];
// "Acceptable" chance of depletion, used for the dotted line and the summary sentence:
export const RISK_THRESHOLD = 0.05;
// ===========================================================================

export const rateKey = (rate) => `w|${rate}`;

// The jobs to run, in the form worker.js expects.
export function buildWithdrawalCells(startYear) {
  return WITHDRAWAL_RATES.map((rate) => ({ key: rateKey(rate), withdrawalRate: rate, startYear }));
}

// Ages to draw a line for: the final age and 5, 10 and 15 years before it (only those at or
// after the age withdrawals start, since earlier ages can't be affected by withdrawals).
export function checkpointAges(ages, startAge) {
  const last = ages[ages.length - 1];
  return [last - 15, last - 10, last - 5, last].filter((a) => a >= startAge && a >= ages[0]);
}

// grid = { cells: { key: {topupCumulative} }, n, ages, startAge }
// "Depleted by age A" = share of trials that had run out of money at least once by the end of age A.
export function depletionSeries(grid) {
  const ageList = checkpointAges(grid.ages, grid.startAge);
  const series = ageList.map((age) => {
    const i = grid.ages.indexOf(age);
    return { age, probs: WITHDRAWAL_RATES.map((r) => grid.cells[rateKey(r)].topupCumulative[i] / grid.n) };
  });
  const final = series[series.length - 1];
  // Highest rate whose depletion chance by the final age stays within the threshold
  // (scanning up from 0% and stopping at the first rate that breaks it).
  let sustainable = null;
  for (let i = 0; i < WITHDRAWAL_RATES.length; i++) {
    if (final.probs[i] <= RISK_THRESHOLD) sustainable = WITHDRAWAL_RATES[i];
    else break;
  }
  return { rates: WITHDRAWAL_RATES, series, sustainable, finalAge: final.age };
}
