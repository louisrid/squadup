// Match & season engine — exact port of engine_final.py (tuned & verified).
// Do not change constants without re-running calibration.

const PARAMS = {
  BASE_LAMBDA: 1.35,
  K: 0.085,
  EVENT_RATE: 1 / 12,
  EVENT_SIZE: 5,
  FORM_MOD: 2.0,
  AI_MEAN_OFF: { 2: -6.2, 3: -5.4, 4: -4.5, 5: -4.0, 6: -3.5 },
  AI_SD: 3.4,
  COMEBACK: 0.8,
  MATCH_NOISE: 1.7,
};

// ---------- randomness ----------
function gauss(mean = 0, sd = 1) {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function poisson(lambda) {
  const L = Math.exp(-lambda);
  let k = 0, p = 1;
  for (;;) {
    p *= Math.random();
    if (p <= L) return k;
    k++;
  }
}
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- season events (rolled ONCE at season start, per player) ----------
function rollSeasonEvent() {
  if (Math.random() < PARAMS.EVENT_RATE) {
    return Math.random() < 0.5 ? PARAMS.EVENT_SIZE : -PARAMS.EVENT_SIZE;
  }
  return 0;
}

// ---------- team strength ----------
// starters: array of player objs {name,pos,rating,seasonMod}. formation: 'DEF'|'BAL'|'ATT'
function teamStrength(starters, formation) {
  const eff = (p) => {
    const r = p.rating + (p.seasonMod || 0);
    return r <= 88 ? r : 88 + (r - 88) * 0.45; // diminishing returns: a 96 plays like a 91.6
  };
  const atkPlayers = starters.filter((p) => p.pos === 'ATT' || p.pos === 'MID');
  const defPlayers = starters.filter((p) => p.pos === 'GK' || p.pos === 'DEF');
  const allOut = starters.filter((p) => p.pos !== 'GK');
  const meanOf = (ps) => ps.reduce((s, p) => s + eff(p), 0) / ps.length;
  // free XIs can have no MID/ATT (park the bus) or no DEF: fall back to outfield mean with a penalty
  let attack = atkPlayers.length ? meanOf(atkPlayers) : (allOut.length ? meanOf(allOut) - 3 : meanOf(starters) - 6);
  let defence = defPlayers.length ? meanOf(defPlayers) : meanOf(starters) - 3;
  // balance matters: missing a whole unit costs you
  const nDef = starters.filter((p) => p.pos === 'DEF').length;
  const nMid = starters.filter((p) => p.pos === 'MID').length;
  const nAtt = starters.filter((p) => p.pos === 'ATT').length;
  if (nMid === 0) { attack -= 1.2; defence -= 0.8; } // no link-up play
  if (nAtt === 0) { attack -= 1.5; }                 // nobody up top
  if (nDef === 0) { defence -= 1.5; }                // keeper abandoned
  if (formation === 'ATT') { attack += PARAMS.FORM_MOD; defence -= PARAMS.FORM_MOD; }
  if (formation === 'DEF') { attack -= PARAMS.FORM_MOD; defence += PARAMS.FORM_MOD; }
  return { attack, defence };
}

// ---------- match ----------
function playMatch(tA, tB) {
  const na = gauss(0, PARAMS.MATCH_NOISE);
  const nb = gauss(0, PARAMS.MATCH_NOISE);
  let la = PARAMS.BASE_LAMBDA * Math.exp(PARAMS.K * ((tA.attack + na) - (tB.defence + nb)));
  let lb = PARAMS.BASE_LAMBDA * Math.exp(PARAMS.K * ((tB.attack + nb) - (tA.defence + na)));
  la = clamp(la, 0.15, 6);
  lb = clamp(lb, 0.15, 6);
  // ~6% of matches are demolitions: one side (usually the stronger) goes ballistic
  if (Math.random() < 0.02) {
    const aStronger = (tA.attack + tA.defence) >= (tB.attack + tB.defence);
    const boostA = Math.random() < (aStronger ? 0.65 : 0.35);
    if (boostA) { la = clamp(la * 2.6 + 1.2, 3.5, 9); lb = clamp(lb * 0.5, 0.1, 1.2); }
    else { lb = clamp(lb * 2.6 + 1.2, 3.5, 9); la = clamp(la * 0.5, 0.1, 1.2); }
  }
  return { goalsA: poisson(la), goalsB: poisson(lb) };
}

// ---------- goalscorer attribution ----------
// weights: ATT 6, MID 3, DEF 1 (GK never scores). effective rating tilts within position.
function attributeGoals(goals, starters) {
  let outfield = starters.filter((p) => p.pos !== 'GK');
  if (!outfield.length) outfield = starters; // keeper-only freak lineup: he scores them all
  const w = (p) => {
    const base = p.pos === 'ATT' ? 6 : p.pos === 'MID' ? 3 : 1;
    return base * (1 + ((p.rating + (p.seasonMod || 0)) - 75) / 50);
  };
  const total = outfield.reduce((s, p) => s + w(p), 0);
  const scorers = [];
  const minutesUsed = new Set();
  for (let g = 0; g < goals; g++) {
    let r = Math.random() * total;
    let scorer = outfield[outfield.length - 1];
    for (const p of outfield) { r -= w(p); if (r <= 0) { scorer = p; break; } }
    let minute = 1 + Math.floor(Math.random() * 90);
    while (minutesUsed.has(minute)) minute = 1 + Math.floor(Math.random() * 90);
    minutesUsed.add(minute);
    scorers.push({ name: scorer.name, minute });
  }
  return scorers.sort((a, b) => a.minute - b.minute);
}

// assists: 60% of goals get one, weighted MID 5, ATT 3, DEF 1, never the scorer
function attributeAssists(scorers, starters) {
  const outfield = starters.filter((p) => p.pos !== 'GK');
  const w = (p) => (p.pos === 'MID' ? 5 : p.pos === 'ATT' ? 3 : 1);
  return scorers.map((s) => {
    if (Math.random() > 0.6) return { ...s, assist: null };
    const cands = outfield.filter((p) => p.name !== s.name);
    if (!cands.length) return { ...s, assist: null };
    const total = cands.reduce((t, p) => t + w(p), 0);
    let r = Math.random() * total;
    let a = cands[cands.length - 1];
    for (const p of cands) { r -= w(p); if (r <= 0) { a = p; break; } }
    return { ...s, assist: a.name };
  });
}

// ---------- commentary templates ----------
const TPL = {
  goal: [
    "{m}' {p} scores!",
    "{m}' {p} buries it.",
    "{m}' {p} with a rocket.",
    "{m}' {p} taps it in.",
    "{m}' {p} finds the corner.",
    "{m}' {p} heads it home.",
    "{m}' cool as you like from {p}.",
    "{m}' {p} smashes it in off the bar.",
  ],
  miss: [
    "{p} skies it from six yards.",
    "{p} hits the post.",
    "Huge save denies {p}.",
    "{p} drags it wide.",
    "{p} somehow misses an open goal.",
  ],
  flavour: [
    "End to end stuff.",
    "Scrappy game so far.",
    "Total domination.",
    "Nothing between these sides.",
    "The keeper is keeping them in this.",
  ],
};
function fill(t, p, m) { return t.replace('{p}', p).replace('{m}', m); }

// builds short text event list for a match result
function buildCommentary(result, startersA, startersB, opts) {
  const events = [];
  const sA = attributeAssists(attributeGoals(result.goalsA, startersA), startersA);
  const sB = attributeAssists(attributeGoals(result.goalsB, startersB), startersB);
  // own goals: ~5% of goals are turned in by the OTHER side's defence
  const ogify = (list, oppStarters) => {
    for (const s of list) {
      if (Math.random() < 0.025) {
        const culprit = pick(oppStarters.filter((p) => p.pos === 'DEF')) || pick(oppStarters.filter((p) => p.pos !== 'GK')) || oppStarters[0];
        s.og = true; s.assist = null; s.ogBy = culprit.name;
      }
    }
  };
  ogify(sA, startersB); ogify(sB, startersA);
  for (const s of sA) events.push({ minute: s.minute, side: 'A', scorer: s.og ? null : s.name, assist: s.assist, text: s.og ? `🥅 Own goal! ${s.ogBy} turns it into his own net (${s.minute}')` : fill(pick(TPL.goal), s.name, s.minute) });
  for (const s of sB) events.push({ minute: s.minute, side: 'B', scorer: s.og ? null : s.name, assist: s.assist, text: s.og ? `🥅 Own goal! ${s.ogBy} turns it into his own net (${s.minute}')` : fill(pick(TPL.goal), s.name, s.minute) });
  // red cards: ~4% per side per match (outfielders only)
  const reds = [];
  const redOk = { A: !opts || opts.redA !== false, B: !opts || opts.redB !== false };
  for (const [side, st] of [['A', startersA], ['B', startersB]]) {
    if (!redOk[side]) continue;
    if (Math.random() < 0.025) {
      const p = pick(st.filter((x) => x.pos !== 'GK')); if (!p) continue;
      const minute = 20 + Math.floor(Math.random() * 70);
      events.push({ minute, side, text: `🟥 ${p.name} is SENT OFF! (${minute}') — suspended next game` });
      reds.push({ side, name: p.name });
    }
  }
  // one flavour/miss line for spice if low-scoring
  if (events.length <= 1) {
    const side = Math.random() < 0.5 ? startersA : startersB;
    const p = pick(side.filter((x) => x.pos === 'ATT')) || pick(side);
    events.push({ minute: 1 + Math.floor(Math.random() * 90), side: 'X', text: fill(pick(TPL.miss), p.name, 0) });
  }
  events.sort((a, b) => a.minute - b.minute);
  return { ...result, scorersA: sA, scorersB: sB, events, reds };
}

// winter development: everyone drifts; wonderkids explode
function winterGrowth(p, form) {
  const pot = p.pot != null ? p.pot : p.rating;
  const gap = pot - p.rating;
  let d;
  if (p.wonderkid) {
    // uniform +6..+11, hard ceiling 94 overall, never down
    d = 6 + Math.floor(Math.random() * 6);
    d = Math.max(0, Math.min(d, 94 - p.rating));
  } else if (p.old || gap <= -1) {
    // old: usually fade 1-2, but proven class can still tick up 1-2
    const r = Math.random();
    d = r < 0.5 ? -(1 + Math.floor(Math.random() * 2)) : r < 0.8 ? (1 + Math.floor(Math.random() * 2)) : 0;
  } else if (gap >= 2) {
    // young & rising: up 2-3 usually, down 1-2 sometimes
    const r = Math.random();
    d = r < 0.6 ? (2 + Math.floor(Math.random() * 2)) : r < 0.85 ? -(1 + Math.floor(Math.random() * 2)) : 0;
    if (d > 0) d = Math.min(d, gap + 1);
  } else {
    // prime: mostly stable
    const r = Math.random();
    d = r < 0.4 ? 0 : r < 0.75 ? pick([1, 1, 2]) : pick([-1, -1, -2]);
  }
  // a great half protects you: in-form players never decline
  if (form != null && form >= 7.0 && d < 0) d = form >= 7.8 ? 1 : 0;
  return Math.max(60, Math.min(96, p.rating + d)) - p.rating;
}

// ---------- fixtures: double round robin, 12 teams, circle method ----------
// returns array of 22 matchdays, each an array of 6 [homeIdx, awayIdx] pairs
function buildFixtures(nTeams = 12) {
  const teams = [...Array(nTeams).keys()];
  const rounds = [];
  const n = teams.length;
  const arr = teams.slice(1);
  for (let r = 0; r < n - 1; r++) {
    const md = [];
    const left = [teams[0], ...arr.slice(0, (n - 2) / 2 + 0.5)];
    // simpler: standard circle pairing
    const lineup = [teams[0], ...arr];
    for (let i = 0; i < n / 2; i++) {
      const a = lineup[i], b = lineup[n - 1 - i];
      md.push(r % 2 === 0 ? [a, b] : [b, a]);
    }
    rounds.push(md);
    arr.push(arr.shift());
  }
  const second = rounds.map((md) => md.map(([a, b]) => [b, a]));
  return [...rounds, ...second];
}

// ---------- AI strength ----------
function aiStrengths(nHumans, avgHumanStrength, count) {
  const off = PARAMS.AI_MEAN_OFF[nHumans];
  return Array.from({ length: count }, () => {
    const v = gauss(avgHumanStrength + off, PARAMS.AI_SD);
    return { attack: v, defence: v };
  });
}

module.exports = {
  PARAMS, gauss, poisson, clamp, pick, shuffle,
  rollSeasonEvent, teamStrength, playMatch, winterGrowth,
  attributeGoals, attributeAssists, buildCommentary,
  buildFixtures, aiStrengths,
};
