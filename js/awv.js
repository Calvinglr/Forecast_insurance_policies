// awv.js — AIA Wealth Venture (AWV): fee/bonus rules and the year-by-year forecast.
// A line-by-line port of notebook cells 9 and 17. No DOM code lives here, so it can
// be tested on its own. The plan rules themselves live in data/awv_plan.json.

// ---------------------------------------------------------------------------
// Bonus and charge rules (notebook cell 9)
// ---------------------------------------------------------------------------

const PAYMENTS_PER_YEAR = { Annual: 1, 'Semi-Annual': 2, Quarterly: 4, Monthly: 12 };
export const FREQUENCIES = Object.keys(PAYMENTS_PER_YEAR);

export function withdrawOrReinvest(policyYear, yearsToReinvest) {
  return policyYear <= yearsToReinvest ? 'Reinvest' : 'Withdraw';
}

// Rate for the n-th regular premium received. Returns 0 outside the schedule.
// (Rate only — multiply by the annual premium to get a dollar amount.)
export function welcomeBonusRate(plan, frequency, premiumNumber, annualisedPremium) {
  const schedule = plan.welcomeBonus.schedule[frequency] || [];
  for (let tier = 0; tier < schedule.length; tier++) {
    const [lo, hi] = schedule[tier];
    if (premiumNumber >= lo && premiumNumber <= hi) {
      for (const band of plan.welcomeBonus.rates[tier]) {
        const inBand =
          band.hi === null
            ? annualisedPremium >= band.lo
            : annualisedPremium >= band.lo && annualisedPremium <= band.hi;
        if (inBand) return band.rate === null ? 0 : band.rate;
      }
    }
  }
  return 0;
}

export function investmentBonus(plan, policyYear, onPremiumHoliday, annualisedPremium) {
  if (onPremiumHoliday) return 0;
  const rate = plan.investmentBonus.years.includes(policyYear) ? plan.investmentBonus.rate : 0;
  return rate * annualisedPremium;
}

export function performanceBonus(plan, policyYear, onPremiumHoliday, policyValue) {
  if (onPremiumHoliday) return 0;
  const rate = policyYear >= plan.performanceBonus.startYear ? plan.performanceBonus.rate : 0;
  return rate * policyValue;
}

// Monthly supplementary charge for the first N policy years.
export function supplementaryChargeMonthly(plan, policyYear, policyValue) {
  if (policyYear <= plan.supplementaryCharge.years) {
    return (plan.supplementaryCharge.rate / 12) * policyValue;
  }
  return 0;
}

export function sumAtRisk(totalRegularPaid, totalTopups, totalWithdrawals, policyValue) {
  return Math.max(totalRegularPaid + totalTopups - totalWithdrawals - policyValue, 0);
}

// Annual benefit charge per $1,000 sum-at-risk. Age is clamped to the table's range.
export function benefitChargeRate(plan, gender, attainedAge) {
  const table = plan.benefitChargePer1000[gender];
  const ages = Object.keys(table).map(Number);
  const age = Math.min(Math.max(attainedAge, Math.min(...ages)), Math.max(...ages));
  return table[String(age)];
}

export function benefitChargeMonthly(
  plan, gender, attainedAge, totalRegularPaid, totalTopups, totalWithdrawals, policyValue
) {
  const sar = sumAtRisk(totalRegularPaid, totalTopups, totalWithdrawals, policyValue);
  return (benefitChargeRate(plan, gender, attainedAge) / 1000 / 12) * sar;
}

export function partialWithdrawalCharge(plan, policyYear, amountWithdrawn) {
  const factor = plan.partialWithdrawalCharge[String(policyYear)] ?? 0;
  return factor * amountWithdrawn;
}

// Not used by the forecast yet (premium holiday and full surrender aren't modelled
// in the notebook's forecast either) — ported now so they're ready later.
export function premiumHolidayChargeRate(plan, frequency, premiumNumber) {
  const schedule = plan.premiumHolidayCharge.schedule[frequency] || [];
  for (let tier = 0; tier < schedule.length; tier++) {
    const [lo, hi] = schedule[tier];
    if (premiumNumber >= lo && premiumNumber <= hi) return plan.premiumHolidayCharge.rates[tier];
  }
  return 0;
}
export function fullSurrenderCharge(plan, policyYear, policyValue) {
  return (plan.fullSurrenderCharge[String(policyYear)] ?? 0) * policyValue;
}

// Check the premium against the plan's minimum for the chosen frequency.
export function validateInvestment(plan, frequency, annualPremium) {
  const perPayment = annualPremium / PAYMENTS_PER_YEAR[frequency];
  const min = plan.minRegularPremium[frequency];
  if (perPayment < min) {
    return {
      ok: false,
      message: `${frequency} premium of $${perPayment.toLocaleString()} is below the minimum of $${min.toLocaleString()}.`,
    };
  }
  return { ok: true, message: `$${perPayment.toLocaleString()} ${frequency.toLowerCase()} meets the $${min.toLocaleString()} minimum.` };
}

// ---------------------------------------------------------------------------
// The forecast (notebook cell 17: AWV_run_forecast)
// ---------------------------------------------------------------------------
//
// inputs = {
//   client:     { entryAge, gender },                       // gender: 'Male' | 'Female'
//   investment: { annualPremium, paymentFrequency, premiumPaymentYears,
//                 projectionYears, yearsToReinvest },
//   funds: {                                                // one entry per fund
//     AGAIF: { weight, mu, sigma, dividend, price }, ...   // weight 0..1, mu/sigma annual
//   },
//   shocks:       { AGAIF: [z1, z2, ...], ... },            // standard random draws, one per year
//   distribution: 'normal' | 't',
//   options:      { welcomeBonusAsAmount }                  // see note below
// }
//
// Returns an array with one row per policy year.
export function runForecast(plan, inputs) {
  const { client, investment, funds: fundInputs, shocks, distribution } = inputs;
  const options = inputs.options || {};
  const years = investment.projectionYears;
  const frequency = investment.paymentFrequency;
  const annualisedPremium = investment.annualPremium;
  const premiumPaymentYears = investment.premiumPaymentYears;
  const onPremiumHoliday = false; // not modelled in the notebook either

  // Only funds with a weight above zero take part (same as the notebook).
  const codes = Object.keys(fundInputs).filter((c) => fundInputs[c].weight > 0);
  const weightSum = codes.reduce((s, c) => s + fundInputs[c].weight, 0);
  if (Math.abs(weightSum - 1) > 1e-9) throw new Error(`Fund weights sum to ${weightSum}, not 1.`);

  // Student-t with 3 df, rescaled so its standard deviation is 1 (cell 17: scale_factor).
  const df = 3;
  const tScale = Math.sqrt((df - 2) / df);

  let nav = {}, tav = {}, units = {};
  for (const c of codes) {
    nav[c] = fundInputs[c].price;
    tav[c] = 0;
    units[c] = 0;
  }

  let cumRegularPaid = 0, cumTopup = 0, cumWithdrawals = 0;
  const rows = [];

  for (let t = 0; t < years; t++) {
    const policyYear = t + 1;
    const age = client.entryAge + t;

    const navBeg = { ...nav };
    const tavBeg = { ...tav };
    const unitsBeg = { ...units };
    const totalTavBeg = codes.reduce((s, c) => s + tavBeg[c], 0);

    // --- contributions and bonuses ---
    const annualContribution = policyYear <= premiumPaymentYears ? annualisedPremium : 0;

    // NOTE: the notebook adds the welcome-bonus *rate* (e.g. 0.03) as if it were dollars.
    // Tick "welcomeBonusAsAmount" to use rate x annual premium instead.
    const wbRate = welcomeBonusRate(plan, frequency, policyYear, annualisedPremium);
    const welcomeBonusAmt = options.welcomeBonusAsAmount ? wbRate * annualisedPremium : wbRate;

    const investmentBonusAmt = investmentBonus(plan, policyYear, onPremiumHoliday, annualisedPremium);
    const performanceBonusAmt = performanceBonus(plan, policyYear, onPremiumHoliday, totalTavBeg);
    const contributionAftBonuses =
      annualContribution + welcomeBonusAmt + investmentBonusAmt + performanceBonusAmt;
    cumRegularPaid += annualContribution;

    // --- per-fund subscription, growth and dividends ---
    const unitsSub = {}, navEnd = {}, growth = {}, div = {}, tavGD = {};
    for (const c of codes) {
      const f = fundInputs[c];
      unitsSub[c] = contributionAftBonuses ? (contributionAftBonuses * f.weight) / navBeg[c] : 0;
      const tavSub = tavBeg[c] + unitsSub[c] * navBeg[c];

      const z = shocks[c][t];
      const ret = distribution === 'normal' ? f.mu + f.sigma * z : z * (f.sigma * tScale) + f.mu;

      navEnd[c] = navBeg[c] * (1 + ret);
      growth[c] = (unitsBeg[c] + unitsSub[c]) * (navEnd[c] - navBeg[c]);
      div[c] = (unitsBeg[c] + unitsSub[c]) * f.dividend;
      tavGD[c] = tavSub + growth[c] + div[c];
    }

    // --- withdraw or reinvest dividends ---
    const decision = withdrawOrReinvest(policyYear, investment.yearsToReinvest);
    const totalDiv = codes.reduce((s, c) => s + div[c], 0);
    const withdrawal = decision === 'Withdraw' ? totalDiv : 0;
    const monthlyIncome = withdrawal / 12;
    const pwCharge = withdrawal ? partialWithdrawalCharge(plan, policyYear, withdrawal) : 0;
    cumWithdrawals += withdrawal;

    // --- charges, computed on total value then split by weight ---
    const sumTavGD = codes.reduce((s, c) => s + tavGD[c], 0);
    const tavBeforeFees = sumTavGD - withdrawal - pwCharge;
    const suppCharge = supplementaryChargeMonthly(plan, policyYear, tavBeforeFees) * 12;
    const benCharge =
      benefitChargeMonthly(plan, client.gender, age, cumRegularPaid, cumTopup, cumWithdrawals, tavBeforeFees) * 12;
    const totalFees = suppCharge + benCharge;

    const fundSufficient = tavBeforeFees >= totalFees;
    const topupRequired = fundSufficient ? 0 : totalFees - tavBeforeFees;
    cumTopup += topupRequired;

    const unitsEnd = {}, tavEnd = {};
    for (const c of codes) {
      const w = fundInputs[c].weight;
      const withdrawalF = withdrawal * w;
      const pwChargeF = pwCharge * w;
      const feesF = totalFees * w;
      const topupF = topupRequired * w;

      const unitsFromDiv = div[c] / navEnd[c];
      const tavF = tavGD[c] - withdrawalF - pwChargeF - feesF + topupF;
      unitsEnd[c] = Math.max(
        0,
        unitsBeg[c] + unitsSub[c] + unitsFromDiv
          - withdrawalF / navEnd[c] - pwChargeF / navEnd[c] - feesF / navEnd[c] + topupF / navEnd[c]
      );
      tavEnd[c] = Math.max(0, tavF);
    }

    const totalTavEnd = codes.reduce((s, c) => s + tavEnd[c], 0);

    rows.push({
      policyYear, age,
      navBeg, totalTavBeg,
      welcomeBonus: welcomeBonusAmt,
      investmentBonus: investmentBonusAmt,
      performanceBonus: performanceBonusAmt,
      contribution: annualContribution,
      contributionAftBonuses,
      decision, withdrawal, monthlyIncome,
      partialWithdrawalCharge: pwCharge,
      supplementaryCharge: suppCharge,
      benefitCharge: benCharge,
      totalFees,
      fundSufficient, topupRequired,
      unitsEnd, tavEnd, totalTavEnd,
    });

    nav = navEnd;
    tav = tavEnd;
    units = unitsEnd;
  }
  return rows;
}

// Headline numbers for the summary cards.
export function summarise(rows) {
  const last = rows[rows.length - 1];
  const sum = (key) => rows.reduce((s, r) => s + r[key], 0);
  return {
    finalAge: last.age,
    finalTav: last.totalTavEnd,
    premiumsPaid: sum('contribution'),
    withdrawals: sum('withdrawal'),
    fees: sum('totalFees'),
    topups: sum('topupRequired'),
    firstTopupYear: (rows.find((r) => !r.fundSufficient) || {}).policyYear ?? null,
  };
}
