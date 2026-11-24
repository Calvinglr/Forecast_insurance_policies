// rng.js — seeded random numbers (the JavaScript stand-in for np.random.default_rng(seed)).
//
// NOTE: these will NOT produce the same numbers as numpy for the same seed
// (different algorithm). The *shape* of the randomness is the same, though:
// a normal draw, or a Student-t draw with 3 degrees of freedom.

// mulberry32: a tiny, fast seeded generator. Returns a function that gives
// a uniform number in [0, 1) each time you call it.
export function makeUniform(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Standard normal draws (mean 0, sd 1) using the Box-Muller transform.
export function makeNormal(seed) {
  const u = makeUniform(seed);
  let spare = null;
  return function () {
    if (spare !== null) {
      const s = spare;
      spare = null;
      return s;
    }
    let u1 = 0;
    while (u1 === 0) u1 = u(); // avoid log(0)
    const u2 = u();
    const r = Math.sqrt(-2 * Math.log(u1));
    spare = r * Math.sin(2 * Math.PI * u2);
    return r * Math.cos(2 * Math.PI * u2);
  };
}

// Standard Student-t draws with `df` degrees of freedom:
//   t = Z / sqrt(chi2_df / df), where chi2_df is a sum of df squared normals.
// (Same idea as numpy's rng.standard_t.) Fat tails => occasional big moves.
export function makeStudentT(seed, df = 3) {
  const z = makeNormal(seed);
  return function () {
    let chi2 = 0;
    for (let i = 0; i < df; i++) {
      const x = z();
      chi2 += x * x;
    }
    return z() / Math.sqrt(chi2 / df);
  };
}

// Build the list of "standard shocks" (one per policy year) for each fund.
// Each fund gets its own stream (seed, seed+1, ...) so a fund's path does not
// change when you change the OTHER fund's weight.
// The engine turns a shock into a return:  return = mean + volatility * shock.
export function makeShocks(fundCodes, years, seed, distribution) {
  const out = {};
  fundCodes.forEach((code, i) => {
    const draw =
      distribution === 't' ? makeStudentT(seed + i * 1000, 3) : makeNormal(seed + i * 1000);
    out[code] = Array.from({ length: years }, () => draw());
  });
  return out;
}
