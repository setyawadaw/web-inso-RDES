/* RDES trainer front panel: timing, operator inputs, screen, sound, settings, log.
 * Only this file changes the reactor's state; the drawing code reads it. */
(function () {
  'use strict';
  const R = window.RDES;
  const $ = (id) => document.getElementById(id);

  const TICK_MS = 10;          // one physics tick of real time
  const MAX_CATCH_UP = 500;    // ticks; beyond this simulated time slips
  const HISTORY = 448;         // graph points, one per second
  const LOG_KEEP = 7200;
  const STORE_KEY = 'rdes-trainer-settings';
  const VIEWS = ['numbers', 'graph', 'instructor'];
  const DEFAULTS = { view: 'numbers', accel: 1, sound: 1, noise: true, preset: 0, seed: 1234, log: 1, lock: false };

  // ---- Settings ----------------------------------------------------------
  function loadSettings() {
    const s = Object.assign({}, DEFAULTS);
    try {
      const raw = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
      for (const k of Object.keys(DEFAULTS)) if (typeof raw[k] === typeof DEFAULTS[k]) s[k] = raw[k];
    } catch (e) { /* storage unavailable: run with defaults */ }
    if (!VIEWS.includes(s.view)) s.view = 'numbers';
    if (![1, 2, 5, 10].includes(s.accel)) s.accel = 1;
    s.seed = Math.max(0, Math.min(9999, s.seed | 0));
    return s;
  }
  function saveSettings() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* ignore */ }
  }
  const S = loadSettings();
  /** Effective settings: the exam lock pins the original's behaviour. */
  function eff() {
    if (!S.lock) return S;
    return { view: 'numbers', accel: 1, sound: S.sound, noise: true, preset: S.preset, seed: S.seed, log: Math.min(S.log, 1), lock: true };
  }

  // ---- Simulation state --------------------------------------------------
  let reactor, history = [], logLines = [];
  let coarse = false;
  let dirty = true, graphDirty = true, logDirty = true;

  function hardwareSeed() {
    try { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] || 1; }
    catch (e) { return (Math.random() * 0xFFFFFFFF) >>> 0 || 1; }
  }
  function buildPreset() {
    if (S.preset === 1) return R.linearPreset();
    if (S.preset === 2) return R.seededPreset(S.seed);
    return R.insoPreset();
  }
  function makeReactor() {
    reactor = new R.Reactor(buildPreset(), hardwareSeed());
    reactor.noise = eff().noise;
    history = [];
    presetDrawn = false;
    dirty = graphDirty = true;
  }

  // ---- Messages ----------------------------------------------------------
  let msgTimer = 0;
  const DEFAULT_MSG = $('msg').textContent;
  function say(text) {
    $('msg').textContent = text;
    clearTimeout(msgTimer);
    msgTimer = setTimeout(() => { $('msg').textContent = DEFAULT_MSG; }, 5000);
  }

  // ---- Sound -------------------------------------------------------------
  let ac = null;
  function wakeAudio() {
    if (eff().sound === 0) return;
    try {
      if (!ac) ac = new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state === 'suspended') ac.resume();
    } catch (e) { ac = null; }
  }
  function tone(freq, dur, vol) {
    if (!ac || ac.state !== 'running') return;
    const o = ac.createOscillator(), g = ac.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.value = vol;
    o.connect(g); g.connect(ac.destination);
    o.start();
    o.stop(ac.currentTime + dur);
  }
  let alarmPhase = false;
  function soundTick(now) {
    const mode = eff().sound;
    if (mode === 0 || document.hidden) return;
    // Alarm: 2.6 kHz, 180 ms on in every 400 ms.
    const alarming = reactor.mode === 'tripped' && reactor.cause === 'protection';
    const on = alarming && (now % 400) < 180;
    if (on && !alarmPhase) tone(2600, 0.18, 0.06);
    alarmPhase = on;
    // Ratemeter clicks with an automatic divider (section 10.9).
    if (mode === 2 && !alarming) {
      const cps = reactor.meanCps();
      const range = cps < 50 ? 0 : cps < 500 ? 1 : cps < 5000 ? 2 : 3;
      const r = cps / Math.pow(10, range);
      if (Math.random() < 1 - Math.exp(-r * TICK_MS / 1000)) tone([900, 1300, 1800, 2400][range], 0.004, 0.08);
    }
  }

  // ---- Timing: exact simulated time from the real clock -------------------
  let lastTick = performance.now();
  function pump() {
    const now = performance.now();
    let due = Math.floor((now - lastTick) / TICK_MS);
    if (due <= 0) return;
    if (due > MAX_CATCH_UP) { due = MAX_CATCH_UP; lastTick = now; }
    else lastTick += due * TICK_MS; // the remainder is carried, so no drift
    const steps = due * eff().accel;
    for (let i = 0; i < steps; i++) if (reactor.step()) onReading();
    soundTick(now);
    dirty = true;
  }

  function onReading() {
    history.push({ cps: reactor.last.cps, x: reactor.actual });
    if (history.length > HISTORY) history.shift();
    graphDirty = true;
    const level = eff().log;
    if (level > 0) {
      let line = [reactor.last.timeS, reactor.cfgIndex < 0 ? 0 : reactor.cfgIndex + 1,
        reactor.target().toFixed(3), reactor.actual.toFixed(3), reactor.last.cps,
        reactor.temp.toFixed(1), reactor.status()].join(',');
      if (level > 1) {
        const T = reactor.period();
        line += ',' + [reactor.n.toPrecision(5), (reactor.rho * 1e5).toFixed(1),
          Math.abs(T) > 1e5 ? 'inf' : T.toFixed(1)].join(',');
      }
      logLines.push(line);
      if (logLines.length > LOG_KEEP) logLines.shift();
      logDirty = true;
    }
  }

  // ---- Operator actions --------------------------------------------------
  function selectConfig(i) {
    wakeAudio();
    if (reactor.selectConfig(i)) say('Configuration ' + (i + 1) + ' selected. Press START.');
    else say('A configuration can only be selected while idle with ACTUAL at 0.000.');
    dirty = true;
  }
  function start() {
    wakeAudio();
    if (reactor.start()) say('Running. TIME was reset to 0:00.');
    else if (reactor.cfgIndex < 0) say('START refused: select a configuration first.');
    else say('START refused: the trainer must be idle with ACTUAL at 0.000.');
    dirty = true;
  }
  function scram() {
    wakeAudio();
    if (reactor.scram()) {
      if (eff().sound > 0) tone(1500, 0.4, 0.06);
      say('SCRAM. The rod drives home by itself; START works again when ACTUAL reaches 0.000.');
    } else say('SCRAM only acts while running.');
    dirty = true;
  }
  function knob(clicks) {
    wakeAudio();
    if (!reactor.nudgeTarget(clicks * (coarse ? 50 : 5))) {
      say(reactor.mode === 'tripped' ? 'The knob is inactive while the rod drives home.' : 'The knob is inactive until START.');
    }
    dirty = true;
  }
  function toggleStep() { coarse = !coarse; dirty = true; }
  function setView(v) {
    if (S.lock) { say('The exam lock allows the numbers view only.'); return; }
    S.view = v; saveSettings(); dirty = graphDirty = true;
  }

  // ---- Rendering ---------------------------------------------------------
  const cache = new Map();
  /** Writes text only when it changed, like the firmware's field cache. */
  function put(id, text) {
    if (cache.get(id) === text) return;
    cache.set(id, text);
    $(id).textContent = text;
  }
  function attr(id, name, value) {
    const key = id + '@' + name;
    if (cache.get(key) === value) return;
    cache.set(key, value);
    $(id).setAttribute(name, value);
  }
  function show(id, visible) {
    const key = id + '@hidden';
    if (cache.get(key) === visible) return;
    cache.set(key, visible);
    $(id).hidden = !visible;
  }
  function cls(id, name, on) {
    const key = id + '.' + name;
    if (cache.get(key) === on) return;
    cache.set(key, on);
    $(id).classList.toggle(name, on);
  }
  const clock = (s) => Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  const fmtPeriod = (T) => (!isFinite(T) || Math.abs(T) > 9999 ? 'inf' : T.toFixed(1) + ' s');

  let presetDrawn = false;
  function render() {
    const e = eff(), r = reactor;
    const st = r.status();
    const cps = String(r.last.cps), actual = r.actual.toFixed(3), time = clock(r.timeS());

    put('scrPreset', e.lock ? 'EXAM' : r.p.name);
    put('scrStep', coarse ? 'COARSE' : 'FINE');
    put('btnStep', coarse ? 'COARSE · 0.050' : 'FINE · 0.005');
    show('scrAccel', e.accel > 1);
    put('scrAccel', 'x' + e.accel);

    show('viewNumbers', e.view === 'numbers');
    show('viewGraph', e.view === 'graph');
    show('viewInstr', e.view === 'instructor');

    if (e.view === 'numbers') {
      put('vConfig', r.cfgIndex < 0 ? '-' : String(r.cfgIndex + 1));
      put('vTarget', r.target().toFixed(3));
      put('vActual', actual);
      put('vCps', cps);
      put('vTemp', r.temp.toFixed(1) + ' °C');
      put('vTime', time);
      put('vStatus', st);
      attr('statusBox', 'data-st', st);
      let note = '';
      if (r.mode === 'tripped') note = 'TRIP ' + clock(r.tripTimeS) + ' · ' + r.tripCps + ' CPS';
      else if (r.mode === 'idle') note = r.cfgIndex < 0 ? 'SELECT CONFIG' : 'PRESS START';
      put('vNote', note);
    } else if (e.view === 'graph') {
      put('gCps', cps); put('gActual', actual); put('gTime', time);
      put('gStatus', st); attr('gStatus', 'data-st', st);
      if (graphDirty) { drawGraph(); graphDirty = false; }
    } else {
      put('iCps', cps); put('iActual', actual); put('iTime', time);
      put('iStatus', st); attr('iStatus', 'data-st', st);
      const rhoPcm = r.rho * 1e5;
      put('iN', r.n < 1000 ? r.n.toFixed(3) : r.n.toPrecision(5));
      put('iRho', rhoPcm.toFixed(1) + ' pcm');
      put('iK', (1 / (1 - r.rho)).toFixed(5));
      put('iPer', fmtPeriod(r.period()));
      const w = R.omegaFromRho(r.rho);
      put('iPerInf', w === 0 ? 'inf' : fmtPeriod(1 / w));
      put('iSur', (26.06 * r.rate).toFixed(3) + ' dpm');
      put('iMean', r.meanCps().toFixed(1) + ' cps');
      put('iBank', r.bankIn ? 'IN' : 'OUT');
      if (!presetDrawn) { drawPreset(); presetDrawn = true; }
    }

    for (let i = 0; i < 3; i++) {
      cls('led' + i, 'on', r.cfgIndex === i);
      attr('btnCfg' + i, 'aria-pressed', String(r.cfgIndex === i));
    }
    cls('ledAlarm', 'on', r.mode === 'tripped' && r.cause === 'protection');

    const deg = (-135 + 270 * r.targetMilli / 1000).toFixed(1);
    if (cache.get('knobDeg') !== deg) {
      cache.set('knobDeg', deg);
      $('knobCap').style.transform = 'rotate(' + deg + 'deg)';
      $('knob').setAttribute('aria-valuenow', r.target().toFixed(3));
      $('knob').setAttribute('aria-valuetext', r.target().toFixed(3));
    }

    for (const v of VIEWS) attr('viewBtn' + v[0].toUpperCase() + v.slice(1), 'aria-pressed', String(e.view === v));
    if (logDirty) { drawLog(); logDirty = false; }
  }

  function drawPreset() {
    const p = reactor.p;
    const nTrip = Math.pow(p.tripCps / p.c0, 1 / p.gamma);
    $('iDet').textContent = 'C = ' + p.c0.toFixed(2) + ' · n^' + p.gamma.toFixed(3) + '  trip ' + p.tripCps + ' cps (n = ' + nTrip.toFixed(0) + ')';
    $('iCool').textContent = 'rho0 ' + p.rho0Pcm + ' pcm  bank ' + p.rhoShutdownPcm + ' pcm  rod ' + p.rodRate.toFixed(3) + ' /s  heat ' + p.heatCoef.toFixed(4) + ' · n^' + p.heatExp.toFixed(2);
    const body = $('iCfgTable').tBodies[0];
    body.textContent = '';
    p.cfg.forEach((c, i) => {
      const tr = document.createElement('tr');
      [String(i + 1), c.xc.toFixed(3), (-p.rho0Pcm / c.xc).toFixed(0), c.wsupPcm.toFixed(0), c.alphaPcm.toFixed(1)]
        .forEach((t) => { const td = document.createElement('td'); td.textContent = t; tr.appendChild(td); });
      body.appendChild(tr);
    });
  }

  // Graph: count rate on a log scale 5 to 20,000 cps, rod position 0 to 1,
  // the trip level, one point per second, 448 s of history.
  function drawGraph() {
    const cv = $('graph');
    const box = cv.getBoundingClientRect();
    if (box.width < 10) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = Math.round(box.width * dpr), H = Math.round(box.height * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    const css = getComputedStyle($('screen'));
    const col = (n) => css.getPropertyValue(n).trim();
    const u = W / 480; // scale so the layout matches a 480-pixel-wide panel
    const L = 44 * u, Rm = 30 * u, T = 6 * u, B = 20 * u;
    const pw = W - L - Rm, ph = H - T - B;
    const lo = Math.log10(5), hi = Math.log10(20000);
    const yC = (c) => T + ph * (1 - (Math.log10(Math.min(20000, Math.max(5, c))) - lo) / (hi - lo));
    const yX = (x) => T + ph * (1 - x);
    const xI = (i) => L + pw * (i + HISTORY - history.length) / (HISTORY - 1);

    g.clearRect(0, 0, W, H);
    g.font = `${11 * u}px ${css.fontFamily}`;
    g.lineWidth = Math.max(1, u);
    g.textBaseline = 'middle';
    for (const c of [10, 100, 1000, 10000]) {
      g.strokeStyle = col('--scr-line');
      g.beginPath(); g.moveTo(L, yC(c)); g.lineTo(L + pw, yC(c)); g.stroke();
      g.fillStyle = col('--scr-cps'); g.textAlign = 'right';
      g.fillText(c >= 1000 ? c / 1000 + 'k' : String(c), L - 5 * u, yC(c));
    }
    g.fillStyle = col('--scr-rod'); g.textAlign = 'left';
    for (const x of [0, 0.5, 1]) g.fillText(x.toFixed(1), L + pw + 5 * u, Math.min(H - B, Math.max(T + 6 * u, yX(x))));
    g.strokeStyle = col('--scr-line');
    g.strokeRect(L, T, pw, ph);
    g.fillStyle = col('--scr-label'); g.textBaseline = 'alphabetic';
    for (const s of [0, 120, 240, 360]) {
      const x = L + pw * (1 - s / (HISTORY - 1));
      g.textAlign = s === 0 ? 'right' : 'center';
      g.fillText(s === 0 ? 'now' : '-' + s + ' s', x, H - 5 * u);
    }
    // Trip level.
    const yt = yC(reactor.p.tripCps);
    g.strokeStyle = col('--st-alarm'); g.setLineDash([6 * u, 4 * u]);
    g.beginPath(); g.moveTo(L, yt); g.lineTo(L + pw, yt); g.stroke();
    g.setLineDash([]);
    g.fillStyle = col('--st-alarm'); g.textAlign = 'left'; g.textBaseline = 'bottom';
    g.fillText('TRIP', L + 4 * u, yt - 2 * u);
    if (history.length < 2) return;
    const trace = (fn, color, width) => {
      g.strokeStyle = color; g.lineWidth = width * u; g.lineJoin = 'round';
      g.beginPath();
      history.forEach((pt, i) => { const x = xI(i), y = fn(pt); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
    };
    trace((pt) => yX(pt.x), col('--scr-rod'), 1.5);
    trace((pt) => yC(pt.cps), col('--scr-cps'), 2);
  }

  function logHeader() {
    return 'time_s,config,target,actual,cps,temp_C,status' + (eff().log > 1 ? ',n,rho_pcm,period_s' : '');
  }
  function drawLog() {
    const el = $('log');
    const stick = el.scrollTop + el.clientHeight >= el.scrollHeight - 8;
    const level = eff().log;
    el.textContent = level === 0 ? 'Logging is off.' :
      logHeader() + '\n' + (logLines.length ? logLines.slice(-200).join('\n') : '(the first reading arrives within a second)');
    if (stick) el.scrollTop = el.scrollHeight;
  }

  // ---- Settings panel ----------------------------------------------------
  function syncControls() {
    const lock = S.lock, e = eff();
    $('setAccel').value = String(e.accel);
    $('setSound').value = String(S.sound);
    $('setNoise').value = e.noise ? '1' : '0';
    $('setPreset').value = String(S.preset);
    $('setSeed').value = String(S.seed);
    $('setLog').value = String(e.log);
    $('setAccel').disabled = $('setNoise').disabled = $('setPreset').disabled = lock;
    $('setSeed').disabled = lock || S.preset !== 2;
    $('setLog').options[2].disabled = lock;
    for (const v of ['Graph', 'Instructor']) $('viewBtn' + v).disabled = lock;
    $('lockState').textContent = lock ? 'Exam lock is on' : 'Exam lock is off';
    $('lockHelp').textContent = lock
      ? 'Numbers view, real time, noise on, no hidden values. Hold the button for 3 seconds to clear it.'
      : 'Locks the trainer to the numbers view, real time, noise on and no hidden values.';
    $('btnLock').textContent = lock ? 'Hold to clear' : 'Turn on';
    reactor.noise = e.noise;
    dirty = graphDirty = logDirty = true;
  }
  function changed() { saveSettings(); syncControls(); }

  $('setAccel').addEventListener('change', (ev) => { S.accel = Number(ev.target.value); changed(); });
  $('setSound').addEventListener('change', (ev) => { S.sound = Number(ev.target.value); wakeAudio(); changed(); });
  $('setNoise').addEventListener('change', (ev) => { S.noise = ev.target.value === '1'; changed(); });
  $('setLog').addEventListener('change', (ev) => { S.log = Number(ev.target.value); logLines = []; changed(); });
  function applyPreset(preset, seed) {
    // Applying a preset restarts the simulation, so it needs the permissive.
    if (!reactor.permissive()) {
      say('Preset and seed can only change while idle with the rod at 0.000.');
      syncControls();
      return;
    }
    S.preset = preset;
    S.seed = Math.max(0, Math.min(9999, Math.floor(Number(seed)) || 0));
    makeReactor();
    logLines = [];
    changed();
    say('Preset "' + reactor.p.name + '" loaded. The simulation was restarted.');
  }
  $('setPreset').addEventListener('change', (ev) => applyPreset(Number(ev.target.value), S.seed));
  $('setSeed').addEventListener('change', (ev) => applyPreset(S.preset, ev.target.value));

  // Exam lock: one click turns it on; clearing needs a deliberate 3 s hold.
  let lockArmed = false, holdTimer = 0;
  function holdStart() {
    if (!S.lock || holdTimer) return;
    $('btnLock').textContent = 'Keep holding…';
    holdTimer = setTimeout(() => { holdTimer = 0; S.lock = false; changed(); say('Exam lock cleared.'); }, 3000);
  }
  function holdEnd() {
    if (!holdTimer) return;
    clearTimeout(holdTimer); holdTimer = 0;
    if (S.lock) $('btnLock').textContent = 'Hold to clear';
  }
  $('btnLock').addEventListener('click', () => {
    if (S.lock) return;
    if (!lockArmed) {
      lockArmed = true; $('btnLock').textContent = 'Confirm lock';
      setTimeout(() => { if (lockArmed) { lockArmed = false; syncControls(); } }, 4000);
      return;
    }
    lockArmed = false; S.lock = true; logLines = []; changed();
    say('Exam lock is on. It stays on after a reload.');
  });
  $('btnLock').addEventListener('pointerdown', holdStart);
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) $('btnLock').addEventListener(ev, holdEnd);
  $('btnLock').addEventListener('keydown', (ev) => { if ((ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) holdStart(); });
  $('btnLock').addEventListener('keyup', holdEnd);

  for (const v of VIEWS) $('viewBtn' + v[0].toUpperCase() + v.slice(1)).addEventListener('click', () => setView(v));

  $('btnCopy').addEventListener('click', () => {
    const text = logHeader() + '\n' + logLines.join('\n') + '\n';
    const fallback = () => {
      const range = document.createRange(); range.selectNodeContents($('log'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      say('Copy was blocked. The visible log is selected; press Ctrl+C or Cmd+C.');
    };
    try {
      navigator.clipboard.writeText(text).then(() => say('Copied ' + logLines.length + ' readings as CSV.'), fallback);
    } catch (e) { fallback(); }
  });
  $('btnClear').addEventListener('click', () => { logLines = []; logDirty = true; dirty = true; });

  // ---- Panel inputs ------------------------------------------------------
  for (let i = 0; i < 3; i++) $('btnCfg' + i).addEventListener('click', () => selectConfig(i));
  $('btnStart').addEventListener('click', start);
  $('btnScram').addEventListener('click', scram);
  $('btnUp').addEventListener('click', () => knob(1));
  $('btnDown').addEventListener('click', () => knob(-1));
  $('btnStep').addEventListener('click', toggleStep);

  // Knob: drag around the centre (one click per 15 degrees) or use the wheel.
  const knobEl = $('knob');
  let dragAngle = null, dragAcc = 0;
  const angleOf = (ev) => {
    const b = knobEl.getBoundingClientRect();
    return Math.atan2(ev.clientY - (b.top + b.height / 2), ev.clientX - (b.left + b.width / 2)) * 180 / Math.PI;
  };
  knobEl.addEventListener('pointerdown', (ev) => { knobEl.setPointerCapture(ev.pointerId); dragAngle = angleOf(ev); dragAcc = 0; });
  knobEl.addEventListener('pointermove', (ev) => {
    if (dragAngle === null) return;
    const a = angleOf(ev);
    let d = a - dragAngle;
    if (d > 180) d -= 360; else if (d < -180) d += 360;
    dragAngle = a; dragAcc += d;
    const clicks = Math.trunc(dragAcc / 15);
    if (clicks) { dragAcc -= clicks * 15; knob(clicks); }
  });
  for (const ev of ['pointerup', 'pointercancel']) knobEl.addEventListener(ev, () => { dragAngle = null; });
  let wheelAcc = 0;
  knobEl.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    wheelAcc += ev.deltaMode === 0 ? ev.deltaY : ev.deltaY * 40;
    const clicks = Math.trunc(wheelAcc / 40);
    if (clicks) { wheelAcc -= clicks * 40; knob(-clicks); }
  }, { passive: false });

  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const tag = ev.target.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const k = ev.key;
    if (k === 'ArrowUp' || k === 'ArrowRight') { knob(1); ev.preventDefault(); }
    else if (k === 'ArrowDown' || k === 'ArrowLeft') { knob(-1); ev.preventDefault(); }
    else if (k === '1' || k === '2' || k === '3') selectConfig(Number(k) - 1);
    else if (k === 's' || k === 'S') start();
    else if (k === 'x' || k === 'X' || k === 'Escape') scram();
    else if (k === 'f' || k === 'F') toggleStep();
    else if (k === 'v' || k === 'V') setView(VIEWS[(VIEWS.indexOf(eff().view) + 1) % VIEWS.length]);
  });

  // ---- Go ----------------------------------------------------------------
  makeReactor();
  syncControls();
  setInterval(pump, TICK_MS);
  window.addEventListener('resize', () => { graphDirty = dirty = true; });
  (function frame() {
    pump();
    if (dirty) { dirty = false; render(); }
    requestAnimationFrame(frame);
  })();
  window.__rdes = { get reactor() { return reactor; }, settings: S }; // for the console
})();
