// worker.js — runs simulations in a background thread so the page (and its sliders)
// stays responsive. main.js sends one message to start a job and this file replies.
//
// Two kinds of job:
//   (default)         one big Monte Carlo for the charts  -> progress messages, then 'done'
//   type: 'cells'     a list of sensitivity-grid cells     -> one 'cell' message each, then 'cells-done'

import { runMonteCarlo } from './montecarlo.js';
import { makeTrialShocks } from './rng.js';

self.onmessage = (event) => {
  try {
    if (event.data.type === 'cells') runCells(event.data);
    else runMain(event.data);
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error && error.message ? error.message : error) });
  }
};

function runMain({ plan, inputs, nTrials, seed, fundCodes }) {
  const nextShocks = makeTrialShocks(fundCodes, inputs.investment.projectionYears, seed, inputs.distribution);
  const result = runMonteCarlo(plan, inputs, nTrials, nextShocks, (fraction) =>
    self.postMessage({ type: 'progress', fraction })
  );
  // Hand the big array over without copying it.
  self.postMessage({ type: 'done', result }, [result.finalTavs.buffer]);
}

// Each cell = "every fund in your mix earns this return with this volatility".
// Every cell restarts the same seeded stream, so cells differ only because of the assumption.
function runCells({ plan, inputs, nTrials, seed, fundCodes, cells }) {
  const years = inputs.investment.projectionYears;
  for (const cell of cells) {
    const funds = {};
    for (const [code, f] of Object.entries(inputs.funds)) {
      funds[code] = f.weight > 0 ? { ...f, mu: cell.mu, sigma: cell.sigma } : f;
    }
    const nextShocks = makeTrialShocks(fundCodes, years, seed, inputs.distribution);
    const r = runMonteCarlo(plan, { ...inputs, funds }, nTrials, nextShocks);
    self.postMessage({
      type: 'cell',
      key: cell.key,
      result: { tavP5: r.tavP5, tavMed: r.tavMed, tavP95: r.tavP95, topupCumulative: r.topupCumulative },
    });
  }
  self.postMessage({ type: 'cells-done' });
}
