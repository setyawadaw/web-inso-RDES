/* Checks the core against numbers printed in the design document.
 * Run: node test.js */
'use strict';
const R = require('./core.js');
let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) pass++; else fail++;
  console.log((ok ? 'ok   ' : 'FAIL ') + name + (detail ? '  [' + detail + ']' : ''));
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
// Mean of the three readings the worksheet takes at a stated tau.
const m3 = (at, tau) => (at[tau].cps + at[tau + 1].cps + at[tau + 2].cps) / 3;
function fresh(preset, cfg) {
  const r = new R.Reactor(preset || R.insoPreset(), 12345);
  r.noise = false;
  if (cfg !== undefined) r.selectConfig(cfg);
  return r;
}
function run(r, seconds, onReading) {
  for (let i = 0; i < seconds * 100; i++) if (r.step() && onReading) onReading(r);
}

// 1. Inhour equation against the sheet's Table 2.
const table2 = [[40, 120.8], [60, 91.9], [80, 74.5], [100, 62.8], [120, 54.4], [150, 45.3],
  [180, 38.9], [220, 32.7], [260, 28.2], [300, 24.8], [400, 19.1]];
for (const [T, pcm] of table2) {
  const v = R.inhourRho(T) * 1e5;
  check(`inhour T=${T}s`, near(v, pcm, 0.06), v.toFixed(2) + ' pcm');
}
check('period from 34.65 pcm', near(1 / R.omegaFromRho(34.65e-5), 205.6, 0.5),
  (1 / R.omegaFromRho(34.65e-5)).toFixed(1) + ' s');

// 2. Source equilibrium, configuration 2.
{
  const r = fresh();
  check('shut-down display 24.4 cps', near(r.meanCps(), 24.4, 0.1), r.meanCps().toFixed(2));
  for (const [x, n] of [[0, 1.0], [0.2, 1.3922], [0.4, 2.2903], [0.6, 6.4545]]) {
    const q = fresh(undefined, 1);
    q.start(); q.setTarget(x * 1000); run(q, 1500);
    check(`equilibrium x=${x}`, near(q.n / n, 1, 2e-3), q.n.toFixed(4));
  }
}

// 3. Answer-sheet runs (noise-free model values, section 12.7).
{
  const r = fresh(undefined, 1);
  r.start(); r.setTarget(800);
  let t0 = -1; const at = {};
  run(r, 300, (q) => {
    if (t0 < 0 && q.actual === q.target()) t0 = q.last.timeS;
    if (t0 >= 0) at[q.last.timeS - t0] = { cps: q.last.cps, st: q.status() };
  });
  check('config 2 arrival at 0:40', t0 === 40, 't0=' + t0);
  check('config 2 tau=180 about 1515 cps', near(m3(at,180), 1515, 8), m3(at,180).toFixed(1));
  check('config 2 tau=240 about 1998 cps', near(m3(at,240), 1998, 10), m3(at,240).toFixed(1));
  check('config 2 status RISING', at[180].st === 'RISING');
}
{
  const r = fresh(undefined, 2);
  r.start(); r.setTarget(925);
  // The rod lands at 46.25 s, so TIME reads 0:46 at arrival: step until then.
  while (r.actual !== r.target()) r.step();
  let t0 = r.timeS(), alarmTau = -1, alarmTime = -1; const at = {};
  while (r.sub !== 0) r.step();
  run(r, 320, (q) => {
    if (t0 >= 0 && q.mode === 'running') at[q.last.timeS - t0] = { cps: q.last.cps, temp: q.temp };
    if (alarmTau < 0 && q.cause === 'protection') { alarmTau = q.tripTimeS - t0; alarmTime = q.tripTimeS; }
  });
  check('config 3 arrival at 0:46', t0 === 46, 't0=' + t0);
  check('config 3 tau=60 about 1114 cps', near(m3(at,60), 1114, 6), m3(at,60).toFixed(1));
  check('config 3 tau=120 about 2129 cps', near(m3(at,120), 2129, 10), m3(at,120).toFixed(1));
  check('coolant 21.43 C at tau=60', near(at[61].temp, 21.43, 0.03), at[61].temp.toFixed(3));
  check('coolant 22.58 C at tau=120', near(at[121].temp, 22.58, 0.03), at[121].temp.toFixed(3));
  check('alarm near tau=224 (TIME 4:30)', near(alarmTau, 224, 2), `tau=${alarmTau}, time=${alarmTime}, cps=${r.tripCps}`);
}
for (const [cfg, cps] of [[0, 136.0], [1, 117.9], [2, 112.7]]) {
  const r = fresh(undefined, cfg);
  r.start(); r.setTarget(500); run(r, 25 + 120);
  let sum = 0, k = 0; run(r, 10, (q) => { sum += q.acc === 0 ? q.meanCps() : 0; k++; });
  const mean = r.meanCps();
  check(`plateau x=0.500 config ${cfg + 1}`, near(mean, cps, 1.5), mean.toFixed(1));
  check(`status STABLE config ${cfg + 1}`, r.status() === 'STABLE', r.status());
}

// 4. Interlocks and trips.
{
  const r = fresh();
  check('START refused without configuration', r.start() === false);
  check('knob inactive while idle', r.nudgeTarget(5) === false && r.targetMilli === 0);
  check('select configuration 3', r.selectConfig(2) && r.status() === 'READY');
  run(r, 3);
  check('START accepted, TIME reset', r.start() && r.timeS() === 0);
  check('configuration change refused while running', r.selectConfig(0) === false);
  r.setTarget(925); run(r, 47);
  check('rod lands exactly on TARGET', r.actual === 0.925);
  const nBefore = r.n;
  check('SCRAM accepted', r.scram() && r.mode === 'tripped' && r.targetMilli === 0);
  run(r, 1);
  check('prompt drop after SCRAM', r.n < 0.1 * nBefore, `${nBefore.toFixed(1)} -> ${r.n.toFixed(1)}`);
  check('START and knob refused while rod drives in', !r.start() && !r.nudgeTarget(5));
  let steps = 100;
  while (r.mode !== 'idle' && steps < 10000) { r.step(); steps++; }
  check('permissive returns about 46.25 s after SCRAM', near(steps / 100, 46.25, 0.05), (steps / 100).toFixed(2));
  check('restart without touching the knob', r.start());
}
{
  const once = (preset, prior) => {
    const r = fresh(preset, 1);
    if (prior) { r.start(); r.setTarget(800); run(r, 120); r.scram(); while (r.mode !== 'idle') r.step(); run(r, 20); }
    r.start(); r.setTarget(500); run(r, 60);
    return r.meanCps();
  };
  const a = once(R.insoPreset(), false), b = once(R.insoPreset(), true);
  check('INSO preset repeats a run exactly', a === b, a.toFixed(2));
  const c = once(R.linearPreset(), false), d = once(R.linearPreset(), true);
  check('Linear preset carries precursors over', d > c * 1.02, `${c.toFixed(1)} cold, ${d.toFixed(1)} after a trip`);
}

// 5. Poisson sampler, first two moments.
{
  const rng = new R.XorShift32(987654321);
  for (const mu of [0.5, 5, 9.9, 10, 25, 52.5, 1500, 5000]) {
    const N = 200000; let s = 0, s2 = 0;
    for (let i = 0; i < N; i++) { const k = rng.poisson(mu); s += k; s2 += k * k; }
    const m = s / N, v = s2 / N - m * m;
    const okM = Math.abs(m - mu) < 4 * Math.sqrt(mu / N);
    const okV = Math.abs(v - mu) < 4 * Math.sqrt((mu + 2 * mu * mu) / N);
    check(`poisson mu=${mu}`, okM && okV, `mean ${m.toFixed(3)}, var ${v.toFixed(3)}`);
  }
}

// 6. Seeded presets: a sample of seeds must satisfy the worksheet's requirements.
{
  let bad = 0, n = 0, tauMin = 1e9, tauMax = 0;
  for (let seed = 0; seed < 10000; seed += 97) {
    n++;
    const p = R.seededPreset(seed);
    let ok = p.cfg[0].xc < p.cfg[1].xc && p.cfg[1].xc < p.cfg[2].xc;
    const r2 = fresh(p, 1); r2.start(); r2.setTarget(800); run(r2, 40 + 242);
    ok = ok && r2.mode === 'running';
    const r3 = fresh(p, 2); r3.start(); r3.setTarget(925);
    let t0 = -1, tau = -1;
    run(r3, 400, (q) => {
      if (t0 < 0 && q.actual === q.target() && q.mode === 'running') t0 = q.last.timeS;
      if (tau < 0 && q.cause === 'protection') tau = q.tripTimeS - t0;
    });
    ok = ok && tau >= 150 && tau <= 295;
    tauMin = Math.min(tauMin, tau); tauMax = Math.max(tauMax, tau);
    if (!ok) bad++;
  }
  check(`seeded presets (${n} sampled)`, bad === 0, `alarm tau ${tauMin} to ${tauMax} s, ${bad} failing`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
