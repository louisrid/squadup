// Match & season engine — exact port of engine_final.py (tuned & verified).
// Do not change constants without re-running calibration.

const PARAMS = {
  BASE_LAMBDA: 1.46,
  K: 0.05,
  EVENT_RATE: 1 / 6,
  EVENT_SIZE: 5,
  FORM_MOD: 7,  // formation nudge — Attacking is high-octane (scores+concedes lots), Defensive is a fortress
  TILT_CORR: 0.0015, // cancels exp() convexity bias so no formation nets free points at even ratings
  MID_INFLUENCE: 0.10, // how much winning midfield tilts the game (kept modest so it doesn't inflate goals)
  MID_CAP: 1.0,        // max swing from the midfield battle
  AI_MEAN_OFF: { 1: -2.2, 2: -3.4, 3: -2.8, 4: -2.2, 5: -1.8, 6: -1.5 },
  AI_SD: 3.4,
  COMEBACK: 0.8,
  MATCH_NOISE: 1.15,
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
function rollSeasonEvent(rating) {
  // rare hidden breakout: a sub-86 player quietly overperforms by +7 all season (never surfaced to the player)
  if (rating != null && rating < 86 && Math.random() < 0.055) return 7;
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
    return r <= 90 ? r : 90 + (r - 90) * 0.92; // very gentle cap: a 96 plays like ~95.5
  };
  const att = starters.filter((p) => p.pos === 'ATT');
  const mid = starters.filter((p) => p.pos === 'MID');
  const def = starters.filter((p) => p.pos === 'DEF' || p.pos === 'GK');
  const allOut = starters.filter((p) => p.pos !== 'GK');
  const meanOf = (ps) => ps.reduce((s, p) => s + eff(p), 0) / ps.length;
  // three independent units. an empty unit falls back to the outfield mean with a penalty.
  let attack = att.length ? meanOf(att) : (allOut.length ? meanOf(allOut) - 4 : 78);
  let midfield = mid.length ? meanOf(mid) : (allOut.length ? meanOf(allOut) - 4 : 78);
  let defence = def.length ? meanOf(def) : (allOut.length ? meanOf(allOut) - 4 : 78);
  // chosen formation applies a SMALL explicit tactical nudge (the player counts already
  // shape the raw stats; this is the deliberate tactic on top). symmetric, never broken.
  if (formation === 'ATT') { attack += PARAMS.FORM_MOD; defence -= PARAMS.FORM_MOD; }
  else if (formation === 'DEF') { defence += PARAMS.FORM_MOD; attack -= PARAMS.FORM_MOD; }
  // BAL: no nudge (midfield-heavy shape already gives the midfield-control edge in playMatch)
  return { attack, midfield, defence };
}

// ---------- match ----------
function playMatch(tA, tB) {
  const na = gauss(0, PARAMS.MATCH_NOISE);
  const nb = gauss(0, PARAMS.MATCH_NOISE);
  // midfield battle: whoever controls the middle gets a small, capped boost to BOTH ends.
  // edge is symmetric (A's gain = B's loss) so it can never run away.
  const mA = tA.midfield != null ? tA.midfield : (tA.attack + tA.defence) / 2;
  const mB = tB.midfield != null ? tB.midfield : (tB.attack + tB.defence) / 2;
  const midEdge = clamp((mA - mB) * PARAMS.MID_INFLUENCE, -PARAMS.MID_CAP, PARAMS.MID_CAP);
  const aAtk = tA.attack + midEdge, aDef = tA.defence + midEdge;
  const bAtk = tB.attack - midEdge, bDef = tB.defence - midEdge;
  // Convexity correction: exp() rewards a high-attack/low-defence split more than it punishes it,
  // which would make Attacking net free points. Dampen each side's lambda by a sliver of its own
  // attack-tilt (attack - defence) so all formations earn ~equal points at even ratings, while the
  // scoreline TEXTURE (attacking = more goals both ways, defensive = fortress) is preserved.
  const aTilt = tA.attack - tA.defence, bTilt = tB.attack - tB.defence;
  let la = PARAMS.BASE_LAMBDA * Math.exp(PARAMS.K * ((aAtk + na) - (bDef + nb)) - PARAMS.TILT_CORR * aTilt);
  let lb = PARAMS.BASE_LAMBDA * Math.exp(PARAMS.K * ((bAtk + nb) - (aDef + na)) - PARAMS.TILT_CORR * bTilt);
  la = clamp(la, 0.15, 6);
  lb = clamp(lb, 0.15, 6);
  // ~2% of matches are demolitions: one side (usually the stronger) goes ballistic
  if (Math.random() < 0.02) {
    const aStronger = (aAtk + aDef) >= (bAtk + bDef);
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
    const base = p.pos === 'ATT' ? 9 : p.pos === 'MID' ? 2.5 : 1.1; // forwards score the bulk, defenders occasionally
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

// assists: 60% of goals get one, midfielders supply most; GK can very rarely assist; never the scorer
function attributeAssists(scorers, starters, sentOff) {
  const w = (p) => (p.pos === 'MID' ? 8 : p.pos === 'ATT' ? 3 : p.pos === 'DEF' ? 3 : 0.15); // GK 0.15 = rare; DEF assist > DEF goal
  const off = new Set(sentOff || []);
  return scorers.map((s) => {
    if (Math.random() > 0.6) return { ...s, assist: null };
    const cands = starters.filter((p) => p.name !== s.name && !off.has(p.name));
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
  // red cards FIRST, so the players sent off can be excluded from assists
  const reds = [];
  const redOk = { A: !opts || opts.redA !== false, B: !opts || opts.redB !== false };
  for (const [side, st] of [['A', startersA], ['B', startersB]]) {
    if (!redOk[side]) continue;
    if (Math.random() < 0.051) {
      const pool = (opts && opts.redPool && opts.redPool[side]) || null;
      const cands = st.filter((x) => x.pos !== 'GK' && (!pool || pool.includes(x.name)));
      const p = pick(cands); if (!p) continue;
      const minute = 20 + Math.floor(Math.random() * 70);
      reds.push({ side, name: p.name, minute });
    }
  }
  const sentA = reds.filter((x) => x.side === 'A').map((x) => x.name);
  const sentB = reds.filter((x) => x.side === 'B').map((x) => x.name);
  const sA = attributeAssists(attributeGoals(result.goalsA, startersA), startersA, sentA);
  const sB = attributeAssists(attributeGoals(result.goalsB, startersB), startersB, sentB);
  for (const r of reds) events.push({ minute: r.minute, side: r.side, text: `🟥 ${r.name} is SENT OFF! (${r.minute}') — suspended next game` });
  // own goals: rare
  const ogify = (list, oppStarters) => {
    for (const s of list) {
      if (Math.random() < 0.037) {
        const culprit = pick(oppStarters.filter((p) => p.pos === 'DEF')) || pick(oppStarters.filter((p) => p.pos !== 'GK')) || oppStarters[0];
        s.og = true; s.assist = null; s.ogBy = culprit.name;
      }
    }
  };
  ogify(sA, startersB); ogify(sB, startersA);
  for (const s of sA) events.push({ minute: s.minute, side: 'A', scorer: s.og ? null : s.name, assist: s.assist, text: s.og ? `🥅 Own goal! ${s.ogBy} turns it into his own net (${s.minute}')` : fill(pick(TPL.goal), s.name, s.minute) });
  for (const s of sB) events.push({ minute: s.minute, side: 'B', scorer: s.og ? null : s.name, assist: s.assist, text: s.og ? `🥅 Own goal! ${s.ogBy} turns it into his own net (${s.minute}')` : fill(pick(TPL.goal), s.name, s.minute) });
  // one flavour/miss line for spice if low-scoring
  if (events.length <= 1) {
    const side = Math.random() < 0.5 ? startersA : startersB;
    const p = pick(side.filter((x) => x.pos === 'ATT')) || pick(side);
    events.push({ minute: 1 + Math.floor(Math.random() * 90), side: 'X', text: fill(pick(TPL.miss), p.name, 0) });
  }
  events.sort((a, b) => a.minute - b.minute);
  return { ...result, scorersA: sA, scorersB: sB, events, reds: reds.map((r) => ({ side: r.side, name: r.name })) };
}
// winter development: everyone drifts; wonderkids explode
function winterGrowth(p, form) {
  const pot = p.pot != null ? p.pot : p.rating;
  const gap = pot - p.rating;
  let d;
  if (p.wonderkid) {
    // upgrade to a final rating of 91-94 (even chance across that range), never down
    const target = 91 + Math.floor(Math.random() * 4); // 91,92,93,94
    d = Math.max(0, target - p.rating);
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
    return { attack: v, midfield: v, defence: v };
  });
}

module.exports = {
  PARAMS, gauss, poisson, clamp, pick, shuffle,
  rollSeasonEvent, teamStrength, playMatch, winterGrowth,
  attributeGoals, attributeAssists, buildCommentary,
  buildFixtures, aiStrengths,
};
