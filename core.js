/* RDES trainer core: six-group point kinetics with a source, rod, coolant,
 * detector, counting noise, protection and status logic.
 * No DOM access here, so the same file runs in a browser and in Node (test.js).
 * Section numbers in comments refer to the RDES trainer design document. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RDES = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---- Fixed data (task sheet, section 4.4) --------------------------------
  const BETA = [0.000247, 0.001385, 0.001222, 0.002645, 0.000832, 0.000169];
  const LAMBDA = [0.0127, 0.0317, 0.115, 0.311, 1.40, 3.87];
  const GROUPS = 6;
  const BETA_TOTAL = BETA.reduce((s, b) => s + b, 0); // 0.0065
  const GEN_TIME = 0.0001;      // Lambda, s
  const STEP = 0.01;            // h, s
  const STEPS_PER_S = 100;
  const PCM = 1e-5;
  const RHO_MAX = 0.8 * BETA_TOTAL; // clamp, section 7.6
  const N_MAX = 1e12;
  const RATE_TAU = 3;           // s, status filter
  const RATE_THRESHOLD = 0.002; // 1/s, RISING / FALLING
  const SETTLE_STEPS = 500;     // 5 s TRANSIENT hold

  // ---- Random numbers (section 10) -----------------------------------------
  function lgamma(x) {
    // Lanczos approximation, g = 7, accurate to ~1e-14 for x > 0.
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
      771.32342877765313, -176.61502916214059, 12.507343278686905,
      -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    x -= 1;
    let a = c[0];
    const t = x + 7.5;
    for (let i = 1; i < 9; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  class XorShift32 {
    constructor(seed) {
      this.s = (seed >>> 0) || 0x2545F491; // state must never be zero
    }
    next() {
      let x = this.s;
      x ^= x << 13; x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5; x >>>= 0;
      return (this.s = x);
    }
    /** Uniform in (0, 1): top 23 bits, centred in the bin. */
    uniform() {
      return ((this.next() >>> 9) + 0.5) / 8388608;
    }
    draw(lo, hi) {
      return lo + (this.next() % (hi - lo + 1));
    }
    poisson(mean) {
      if (!(mean > 0)) return 0;
      if (mean < 10) {
        // Knuth: multiply uniforms until the product falls below e^-mean.
        const limit = Math.exp(-mean);
        let k = 0;
        let prod = this.uniform();
        while (prod > limit) { k++; prod *= this.uniform(); }
        return k;
      }
      // Hoermann's PTRS transformed rejection (1993). Exact.
      const slam = Math.sqrt(mean);
      const loglam = Math.log(mean);
      const b = 0.931 + 2.53 * slam;
      const a = -0.059 + 0.02483 * b;
      const invAlpha = 1.1239 + 1.1328 / (b - 3.4);
      const vr = 0.9277 - 3.6224 / (b - 2);
      for (;;) {
        const u = this.uniform() - 0.5;
        const v = this.uniform();
        const us = 0.5 - Math.abs(u);
        const k = Math.floor((2 * a / us + b) * u + mean + 0.43);
        if (us >= 0.07 && v <= vr) return k;
        if (k < 0 || (us < 0.013 && v > us)) continue;
        if (Math.log(v) + Math.log(invAlpha) - Math.log(a / (us * us) + b) <=
            -mean + k * loglam - lgamma(k + 1)) return k;
      }
    }
  }

  // ---- Presets (sections 15, 21.2) -----------------------------------------
  function insoPreset() {
    return {
      name: 'INSO 2026',
      rho0Pcm: -2780, rhoShutdownPcm: -6000, rodRate: 0.020,
      c0: 52.5, gamma: 0.6667, tripCps: 5000,
      ambient: 20.0, heatCoef: 0.0190, heatExp: 0.60, coolRate: 0.20,
      carryOver: false,
      cfg: [
        { xc: 0.655, wsupPcm: 424, alphaPcm: 0, protection: true },
        { xc: 0.710, wsupPcm: 385, alphaPcm: 0, protection: true },
        { xc: 0.730, wsupPcm: 430, alphaPcm: -3.0, protection: true },
      ],
    };
  }

  function linearPreset() {
    const p = insoPreset();
    p.name = 'Linear detector';
    p.gamma = 1.0;
    p.heatCoef = 0.0140;
    p.heatExp = 1.0;
    p.carryOver = true; // keeps the previous run's precursors
    return p;
  }

  /** Seeded preset, section 15.2. Parameters are drawn as physical targets. */
  function seededPreset(seed) {
    seed = ((seed % 10000) + 10000) % 10000;
    const mixed = Math.imul(seed + 1, 2654435761 | 0) >>> 0;
    const rng = new XorShift32((0xA5A5F00D ^ mixed) >>> 0);
    const p = insoPreset();
    p.name = 'Seed ' + String(seed).padStart(4, '0');
    p.seed = seed;

    p.gamma = rng.draw(60, 75) / 100;
    const nTrip = rng.draw(700, 1100);
    p.c0 = p.tripCps / Math.pow(nTrip, p.gamma);

    const xc2 = rng.draw(690, 735);
    const xc1 = xc2 - rng.draw(30, 60);
    const xc3 = xc2 + rng.draw(10, 30);
    const rho800 = rng.draw(30, 40);  // true pcm at x = 0.800, configuration 2
    const rho925 = rng.draw(78, 90);  // true cold pcm at x = 0.925, configuration 3
    const alpha = -rng.draw(20, 35) / 10;
    const rise = rng.draw(55, 75) / 10; // coolant rise at the trip level, deg C

    p.cfg[0].xc = xc1 / 1000;
    p.cfg[1].xc = xc2 / 1000;
    p.cfg[2].xc = xc3 / 1000;
    p.cfg[0].wsupPcm = 0.1 * (-p.rho0Pcm) / p.cfg[0].xc;
    p.cfg[1].wsupPcm = rho800 / (0.800 - p.cfg[1].xc);
    p.cfg[2].wsupPcm = rho925 / (0.925 - p.cfg[2].xc);
    p.cfg[2].alphaPcm = alpha;
    p.heatCoef = rise * p.coolRate / Math.pow(nTrip, p.heatExp);
    return p;
  }

  // ---- Inhour equation (section 6.2) ---------------------------------------
  /** Reactivity (absolute) for a stable period T in seconds. */
  function inhourRho(T) {
    let rho = GEN_TIME / T;
    for (let i = 0; i < GROUPS; i++) rho += BETA[i] / (1 + LAMBDA[i] * T);
    return rho;
  }

  /** Dominant root omega_1 (1/s) of the inhour equation for reactivity rho. */
  function omegaFromRho(rho) {
    if (rho === 0) return 0;
    const f = (w) => {
      let r = GEN_TIME * w;
      for (let i = 0; i < GROUPS; i++) r += BETA[i] * w / (w + LAMBDA[i]);
      return r - rho;
    };
    let lo, hi;
    if (rho > 0) { lo = 0; hi = 1; while (f(hi) < 0) hi *= 2; }
    else { lo = -LAMBDA[0] * (1 - 1e-12); hi = 0; }
    for (let it = 0; it < 200; it++) {
      const mid = 0.5 * (lo + hi);
      if (f(mid) < 0) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
  }

  // ---- The reactor (sections 14, 17) ---------------------------------------
  class Reactor {
    constructor(preset, noiseSeed) {
      this.p = preset;
      this.rng = new XorShift32(noiseSeed === undefined ? 1 : noiseSeed);
      this.noise = true;

      // Solver constants, section 11.4.
      this.a = new Array(GROUPS);
      this.g = 0;
      for (let i = 0; i < GROUPS; i++) {
        this.a[i] = 1 / (1 + STEP * LAMBDA[i]);
        this.g += STEP * STEP * LAMBDA[i] * BETA[i] * this.a[i] / GEN_TIME;
      }
      this.src = -preset.rho0Pcm * PCM / GEN_TIME; // S = 278 /s

      this.c = new Array(GROUPS).fill(0);
      this.mode = 'idle';      // 'idle' | 'running' | 'tripped'
      this.cause = 'none';     // 'none' | 'scram' | 'protection'
      this.cfgIndex = -1;
      this.bankIn = true;
      this.targetMilli = 0;
      this.actual = 0;
      this.moving = false;
      this.sinceMove = 0;
      this.steps = 0;
      this.sub = 0;
      this.acc = 0;
      this.overTrip = 0;
      this.tripTimeS = 0;
      this.tripCps = 0;
      this.setShutdownEquilibrium();
      this.last = { cps: Math.round(this.meanCps()), timeS: 0 };
    }

    setShutdownEquilibrium() {
      const p = this.p;
      this.temp = p.ambient;
      this.rho = (p.rho0Pcm + p.rhoShutdownPcm) * PCM;
      this.n = -this.src * GEN_TIME / this.rho;
      for (let i = 0; i < GROUPS; i++) this.c[i] = BETA[i] * this.n / (LAMBDA[i] * GEN_TIME);
      this.rate = 0;
    }

    rodRho(x) {
      const c = this.p.cfg[this.cfgIndex < 0 ? 1 : this.cfgIndex];
      const rho0 = this.p.rho0Pcm * PCM;
      if (x < c.xc) return rho0 * (1 - x / c.xc);
      return c.wsupPcm * PCM * (x - c.xc);
    }

    meanCps() { return this.p.c0 * Math.pow(this.n, this.p.gamma); }
    timeS() { return Math.floor(this.steps / STEPS_PER_S); }
    target() { return this.targetMilli * 0.001; }
    permissive() { return this.mode === 'idle' && this.actual === 0; }

    // -- Operator actions. Each returns true when accepted (section 14.2). --
    selectConfig(i) {
      if (!this.permissive() || i < 0 || i > 2) return false;
      this.cfgIndex = i;
      return true;
    }

    start() {
      if (!this.permissive() || this.cfgIndex < 0) return false;
      if (!this.p.carryOver) this.setShutdownEquilibrium();
      this.mode = 'running';
      this.cause = 'none';
      this.bankIn = false;
      this.steps = 0;
      this.sub = 0;
      this.acc = 0;
      this.overTrip = 0;
      this.sinceMove = 0;
      return true;
    }

    nudgeTarget(deltaMilli) {
      if (this.mode !== 'running') return false;
      this.targetMilli = Math.max(0, Math.min(1000, this.targetMilli + deltaMilli));
      return true;
    }

    setTarget(milli) {
      if (this.mode !== 'running') return false;
      this.targetMilli = Math.max(0, Math.min(1000, Math.round(milli)));
      return true;
    }

    scram() {
      if (this.mode !== 'running') return false;
      this.trip('scram');
      return true;
    }

    trip(cause) {
      this.mode = 'tripped';
      this.cause = cause;
      this.bankIn = true;
      this.targetMilli = 0;
      this.tripTimeS = this.timeS();
      this.tripCps = this.last.cps;
    }

    /** One 10 ms step. Returns true when a new one-second reading was latched. */
    step() {
      const p = this.p, h = STEP;
      const c = p.cfg[this.cfgIndex < 0 ? 1 : this.cfgIndex];

      // 1. Rod: rate-limited, lands exactly on TARGET.
      const tgt = this.targetMilli * 0.001;
      const d = tgt - this.actual;
      const maxMove = p.rodRate * h;
      this.moving = d !== 0;
      if (Math.abs(d) <= maxMove + 1e-9) this.actual = tgt; // tolerance absorbs rounding so arrival is on the exact step
      else this.actual += d > 0 ? maxMove : -maxMove;
      if (this.moving) this.sinceMove = 0; else this.sinceMove++;

      // 2. Reactivity: rod + feedback + shutdown bank, clamped at 0.8 beta.
      let rho = this.rodRho(this.actual) + c.alphaPcm * PCM * (this.temp - p.ambient);
      if (this.bankIn) rho += p.rhoShutdownPcm * PCM;
      if (rho > RHO_MAX) rho = RHO_MAX;
      this.rho = rho;

      // 3. Kinetics: backward Euler in closed form (Schur complement).
      const nOld = this.n;
      let num = this.n + h * this.src;
      for (let i = 0; i < GROUPS; i++) num += h * LAMBDA[i] * this.c[i] * this.a[i];
      this.n = num / (1 - h * (rho - BETA_TOTAL) / GEN_TIME - this.g);
      if (this.n > N_MAX) this.n = N_MAX;
      for (let i = 0; i < GROUPS; i++) {
        this.c[i] = (this.c[i] + h * BETA[i] / GEN_TIME * this.n) * this.a[i];
      }

      // 4. Smoothed logarithmic rate for the status word.
      const inst = (this.n - nOld) / (this.n * h);
      this.rate += (h / RATE_TAU) * (inst - this.rate);

      // 5. Coolant, explicit Euler.  6. Detector accumulation.
      this.temp += h * (p.heatCoef * Math.pow(this.n, p.heatExp) - p.coolRate * (this.temp - p.ambient));
      this.acc += this.meanCps() * h;

      // 7. One-second reading and protection.
      let latched = false;
      this.steps++;
      if (++this.sub >= STEPS_PER_S) {
        this.sub = 0;
        this.latchReading();
        latched = true;
      }

      // 8. Automatic return of the permissive after a trip.
      if (this.mode === 'tripped' && this.actual === 0) {
        this.mode = 'idle';
        this.cause = 'none';
      }
      return latched;
    }

    latchReading() {
      const expected = this.acc;
      this.acc = 0;
      const cps = this.noise ? this.rng.poisson(expected) : Math.round(expected);
      this.last = { cps, timeS: this.timeS() };
      if (this.mode === 'running' && this.p.cfg[this.cfgIndex].protection) {
        this.overTrip = cps >= this.p.tripCps ? this.overTrip + 1 : 0;
        if (this.overTrip >= 2) {
          this.trip('protection');
          this.tripCps = cps;
        }
      }
    }

    status() {
      if (this.mode === 'tripped') return this.cause === 'protection' ? 'ALARM' : 'SCRAM';
      if (this.mode === 'idle') return this.cfgIndex < 0 ? 'IDLE' : (this.actual === 0 ? 'READY' : 'IDLE');
      if (this.moving || this.sinceMove < SETTLE_STEPS) return 'TRANSIENT';
      if (this.rate > RATE_THRESHOLD) return 'RISING';
      if (this.rate < -RATE_THRESHOLD) return 'FALLING';
      return 'STABLE';
    }

    /** Instantaneous period in seconds (Infinity when flat). */
    period() { return this.rate === 0 ? Infinity : 1 / this.rate; }
  }

  return {
    BETA, LAMBDA, BETA_TOTAL, GEN_TIME, STEP, STEPS_PER_S, PCM,
    XorShift32, Reactor, lgamma,
    insoPreset, linearPreset, seededPreset,
    inhourRho, omegaFromRho,
  };
});
