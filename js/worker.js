// worker.js — runs the Monte Carlo in a background thread so the page (and its sliders)
// stays responsive. main.js sends one message to start a run; this file replies with
// progress updates and then the finished results.

import { runMonteCarlo } from './montecarlo.js';
import { makeTrialShocks } from './rng.js';

self.onmessage = (event) => {
  const { plan, inputs, nTrials, seed, fundCodes } = event.data;
  try {
    const nextShocks = makeTrialShocks(fundCodes, inputs.investment.projectionYears, seed, inputs.distribution);
    const result = runMonteCarlo(plan, inputs, nTrials, nextShocks, (fraction) =>
      self.postMessage({ type: 'progress', fraction })
    );
    // Hand the big array over without copying it.
    self.postMessage({ type: 'done', result }, [result.finalTavs.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error && error.message ? error.message : error) });
  }
};
