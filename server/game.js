// Game state machine. One Game instance per lobby. Server-authoritative.
// Pool selection uses FC26 ratings ONLY. Engine ratings are used solely for
// match simulation, form scores, injuries and awards — never for what appears at auction.
const E = require('./engine');
const ALL_PLAYERS = require('./data/players.json');

const FILLER = ALL_PLAYERS.filter((p) => p.fc26 < 84);

// Legends: respin-only pool. FC26 95, white/gold cards. Engine ratings are defaults (editable).
const LEGENDS = [
  { name: 'Lev Yashin', pos: 'GK', fc26: 95, rating: 93, legend: true },
  { name: 'Gianluigi Buffon', pos: 'GK', fc26: 95, rating: 92, legend: true },
  { name: 'Paolo Maldini', pos: 'DEF', fc26: 95, rating: 95, legend: true },
  { name: 'Franz Beckenbauer', pos: 'DEF', fc26: 95, rating: 94, legend: true },
  { name: 'Franco Baresi', pos: 'DEF', fc26: 95, rating: 93, legend: true },
  { name: 'Zinedine Zidane', pos: 'MID', fc26: 95, rating: 95, legend: true },
  { name: 'Diego Maradona', pos: 'MID', fc26: 95, rating: 95, legend: true },
  { name: 'Johan Cruyff', pos: 'MID', fc26: 95, rating: 94, legend: true },
  { name: 'Pelé', pos: 'ATT', fc26: 95, rating: 95, legend: true },
  { name: 'Ronaldo Nazário', pos: 'ATT', fc26: 95, rating: 95, legend: true },
  { name: 'Eusébio', pos: 'ATT', fc26: 95, rating: 93, legend: true },
  { name: 'Romário', pos: 'ATT', fc26: 95, rating: 92, legend: true },
];

const AI_CLUB_NAMES = [
  'Redbridge United', 'Harton Town', 'Mill Lane FC', 'Eastvale Rovers',
  'Kings Heath FC', 'Brockwell City', 'Norfield Athletic', 'Saltway Wanderers',
  'Dunmore FC', 'Westcliff Albion',
];

const FORMATIONS = {
  DEF: { slots: ['GK', 'DEF', 'DEF', 'MID', 'ATT'], label: 'Defensive' },
  BAL: { slots: ['GK', 'DEF', 'MID', 'MID', 'ATT'], label: 'Balanced' },
  ATT: { slots: ['GK', 'DEF', 'MID', 'ATT', 'ATT'], label: 'Attacking' },
};

const FAST = process.env.FAST === '1';
const TIMINGS = {
  AUCTION_START_MS: FAST ? 150 : 20000,
  AUCTION_BID_ADD_MS: FAST ? 60 : 3000,
  AUCTION_MAX_MS: FAST ? 600 : 40000,
  AUCTION_BETWEEN_MS: FAST ? 30 : 4000,
  LOT_REVEAL_MS: FAST ? 20 : 3400,
  REVEAL_QUICK_MS: FAST ? 15 : 3000,
  REVEAL_FEATURED_MS: FAST ? 25 : 13000,
  REVEAL_MATCHDAY_GAP_MS: FAST ? 5 : 800,
  DISCONNECT_PAUSE_MS: FAST ? 400 : 30000,
  PICK_STARTERS_MS: FAST ? 800 : 60000,
  WINTER_FALLBACK_MS: FAST ? 1500 : 180000,
};

const mid = () => String(10 + Math.floor(Math.random() * 90)); // 2-digit lobby code, 10-99

class Game {
  constructor(code, io) {
    this.code = code;
    this.io = io;
    this.phase = 'lobby'; // lobby|auction|setup|firstHalf|winter|secondHalf|finished
    this.managers = [];
    this.hostId = null;
    this.auction = null;
    this.season = null;
    this.timers = {};
    this.paused = false;
    this.speed = 1; // host toggle: 1x or 2x auction pace
  }

  sp(ms) { return Math.round(ms / this.speed); }

  // ---------- lobby ----------
  addManager(id, name, club) {
    if (this.phase !== 'lobby') return { error: 'Game already started' };
    if (this.managers.length >= 6) return { error: 'Lobby full' };
    if (this.managers.some((m) => m.name === name)) return { error: 'Name taken' };
    const m = { id, name, club, ready: false, budget: 100, squad: [], starters: [], formation: 'BAL', sacked: false, injured: null, connected: true, signings: [] };
    this.managers.push(m);
    if (!this.hostId) this.hostId = id;
    this.broadcastLobby();
    return { ok: true };
  }
  setReady(id, ready) {
    const m = this.managers.find((x) => x.id === id);
    if (m) m.ready = ready;
    this.broadcastLobby();
  }
  canStart() {
    return this.managers.length >= 2 && this.managers.every((m) => m.ready);
  }
  broadcastLobby() {
    this.io.emit('lobby', {
      code: this.code,
      hostId: this.hostId,
      managers: this.managers.map((m) => ({ id: m.id, name: m.name, club: m.club, ready: m.ready })),
    });
  }

  hostSetSpeed(managerId, fast) {
    if (managerId !== this.hostId) return { error: 'Host only' };
    const target = fast ? 2 : 1;
    if (this.speed === target) return { ok: true, speed: this.speed };
    const prev = this.speed;
    this.speed = target;
    const a = this.auction;
    if (a && a.current && a.deadline > Date.now() && !this.paused) {
      const left = a.deadline - Date.now();
      a.deadline = Date.now() + left * (prev / target);
      this.io.emit('bid', {
        player: a.current.name, amount: a.highBid,
        manager: a.highBidder ? this.managers.find((x) => x.id === a.highBidder).name : null,
        deadline: a.deadline,
      });
      this.armLotTimer();
    }
    this.io.emit('speed', { speed: this.speed });
    return { ok: true, speed: this.speed };
  }

  // ---------- auction pool (FC26 ONLY) ----------
  buildAuctionPool() {
    const n = this.managers.length;
    // 7 lots per manager, ALL FC26 83+. Tier mix: n stars (88+), n good (86-87), 5n mid (83-85).
    // EXACT position quotas so every squad need is structurally covered:
    const posQuota = { GK: n + 1, DEF: 2 * n, MID: 2 * n, ATT: 2 * n - 1 }; // sums to 7n
    const tiers = [
      { lo: 88, hi: 99, count: n },
      { lo: 86, hi: 87, count: n },
      { lo: 83, hi: 85, count: 5 * n },
    ];
    const pool = [];
    const inPool = new Set();
    for (const t of tiers) {
      const cand = E.shuffle(ALL_PLAYERS.filter((p) => p.fc26 >= t.lo && p.fc26 <= t.hi && !inPool.has(p.name)));
      for (const p of cand.slice(0, t.count)) { pool.push(p); inPool.add(p.name); }
    }
    // enforce exact position quotas via same-tier swaps (total quota == pool size,
    // so filling every deficit automatically clears every surplus)
    const count = (pos) => pool.filter((p) => p.pos === pos).length;
    for (const pos of Object.keys(posQuota)) {
      let guard = 0;
      while (count(pos) < posQuota[pos] && guard++ < 60) {
        const victims = pool.filter((v) => v.pos !== pos && count(v.pos) > posQuota[v.pos]);
        if (!victims.length) break;
        const victim = E.pick(victims);
        const tier = tiers.find((t) => victim.fc26 >= t.lo && victim.fc26 <= t.hi);
        let repl = E.shuffle(ALL_PLAYERS.filter((p) => p.pos === pos && p.fc26 >= tier.lo && p.fc26 <= tier.hi && !inPool.has(p.name)))[0];
        if (!repl) repl = E.shuffle(ALL_PLAYERS.filter((p) => p.pos === pos && p.fc26 >= 83 && !inPool.has(p.name)))[0];
        if (!repl) break;
        inPool.delete(victim.name); inPool.add(repl.name);
        pool[pool.indexOf(victim)] = repl;
      }
    }
    // first lot always FC26 <= 85; first two lots are the cheapest names
    pool.sort((a, b) => a.fc26 - b.fc26);
    const openers = pool.slice(0, 2);
    return [...openers, ...E.shuffle(pool.slice(2))];
  }

  // ---------- auction flow ----------
  startGame() {
    if (!this.canStart()) return;
    this.phase = 'auction';
    const pool = this.buildAuctionPool();
    this.auction = {
      window: 'main', queue: pool, index: -1,
      current: null, highBid: 0, highBidder: null, deadline: 0, unsold: [], outs: new Set(),
    };
    this.io.emit('phase', { phase: 'auction', window: 'main', poolSize: pool.length });
    this.nextLot();
  }

  static formationFeasible(positions, slotsLeft) {
    const have = { GK: 0, DEF: 0, MID: 0, ATT: 0 };
    for (const p of positions) have[p]++;
    return Object.values(FORMATIONS).some((f) => {
      let deficit = 0;
      for (const pos of ['GK', 'DEF', 'MID', 'ATT']) {
        const need = f.slots.filter((s) => s === pos).length;
        deficit += Math.max(need - have[pos], 0);
      }
      return deficit <= slotsLeft;
    });
  }

  purchaseLegal(m, pos) {
    const after = [...m.squad.map((p) => p.pos), pos];
    return Game.formationFeasible(after, 6 - after.length);
  }

  activeManagers() {
    return this.managers.filter((m) => !m.sacked);
  }

  nextLot() {
    clearTimeout(this.timers.lot);
    const a = this.auction;
    if (a.current) {
      if (a.highBidder) {
        const m = this.managers.find((x) => x.id === a.highBidder);
        m.budget -= a.highBid;
        m.squad.push({ ...a.current, seasonMod: 0 });
        m.signings.push({ player: a.current.name, price: a.highBid, window: a.window });
        this.io.emit('lotSold', { player: a.current.name, pos: a.current.pos, price: a.highBid, manager: m.name });
      } else {
        a.unsold.push(a.current);
        this.io.emit('lotUnsold', { player: a.current.name });
      }
      this.broadcastBudgets();
    }
    const buyers = this.activeManagers().filter((m) => m.squad.length < 6);
    a.index++;
    while (a.index < a.queue.length && !this.activeManagers().some((m) => this.canBuyPlayer(m, a.queue[a.index]))) {
      const sk = a.queue[a.index];
      a.unsold.push(sk);
      this.io.emit('lotSkipped', { player: sk.name, pos: sk.pos });
      a.index++;
    }
    if (a.index >= a.queue.length || buyers.length === 0) return this.endAuction();
    a.current = null;
    a.highBid = 0;
    a.highBidder = null;
    if (a.index === 0) return void setTimeout(() => this.presentLot(), FAST ? 25 : 3400);
    const host = this.managers.find((m) => m.id === this.hostId);
    this.io.emit('awaitNext', { hostName: host ? host.name : 'Host' });
    if (FAST) setTimeout(() => this.presentLot(), 25);
  }

  canBuyPlayer(m, p) {
    if (m.sacked || m.squad.length >= 6 || m.budget < 1) return false;
    if (p.pos === 'GK' && m.squad.some((x) => x.pos === 'GK')) return false;
    return Game.formationFeasible([...m.squad.map((x) => x.pos), p.pos], 6 - m.squad.length - 1);
  }

  hostNextLot(managerId) {
    if (managerId !== this.hostId) return { error: 'Host only' };
    const a = this.auction;
    if (!a || a.current) return { error: 'Lot already live' };
    if (this.phase !== 'auction') return { error: 'No auction' };
    this.presentLot();
    return { ok: true };
  }

  presentLot() {
    const a = this.auction;
    a.current = a.queue[a.index];
    a.highBid = 0;
    a.highBidder = null;
    a.outs = new Set();
    this.io.emit('lotReveal', {
      index: a.index, total: a.queue.length,
      player: { name: a.current.name, pos: a.current.pos }, // ratings NEVER sent
      revealMs: this.sp(TIMINGS.LOT_REVEAL_MS),
    });
    setTimeout(() => {
      if (!a.current) return;
      a.deadline = Date.now() + this.sp(TIMINGS.AUCTION_START_MS);
      this.io.emit('lot', {
        index: a.index, total: a.queue.length,
        player: { name: a.current.name, pos: a.current.pos },
        deadline: a.deadline,
      });
      this.armLotTimer();
    }, this.sp(TIMINGS.LOT_REVEAL_MS));
  }

  armLotTimer() {
    clearTimeout(this.timers.lot);
    if (this.paused) return;
    const ms = this.auction.deadline - Date.now();
    this.timers.lot = setTimeout(() => this.nextLot(), Math.max(ms, 0));
  }

  bid(managerId, amount) {
    const a = this.auction;
    if (this.phase !== 'auction') return { error: 'No auction running' };
    if (!a || !a.current || this.paused) return { error: 'No active lot' };
    const m = this.managers.find((x) => x.id === managerId);
    if (!m || m.sacked) return { error: 'Not in game' };
    amount = Math.floor(amount);
    const minBid = a.highBid + 1;
    if (amount < minBid) return { error: `Min bid £${minBid}m` };
    if (amount > m.budget) return { error: 'Not enough budget' };
    if (a.highBidder === m.id) return { error: 'Already highest bidder' };
    if (m.squad.length >= 6) return { error: 'Squad full' };
    if (!this.purchaseLegal(m, a.current.pos)) return { error: 'Would make required positions unfillable' };
    if (a.current.pos === 'GK' && m.squad.some((p) => p.pos === 'GK')) return { error: 'You already have a keeper' };
    if (a.outs.has(m.id)) return { error: 'You gave up on this lot' };
    a.highBid = amount;
    a.highBidder = m.id;
    a.deadline = Math.min(a.deadline + this.sp(TIMINGS.AUCTION_BID_ADD_MS), Date.now() + this.sp(TIMINGS.AUCTION_MAX_MS));
    this.io.emit('bid', { player: a.current.name, amount, manager: m.name, deadline: a.deadline });
    this.armLotTimer();
    this.resolveEarly();
    return { ok: true };
  }

  passLot(managerId) {
    const a = this.auction;
    if (!a || !a.current) return { error: 'No live lot' };
    const m = this.managers.find((x) => x.id === managerId);
    if (!m || m.sacked) return { error: 'Not in game' };
    if (a.highBidder === managerId) return { error: "You're the highest bidder" };
    if (a.outs.has(managerId)) return { error: 'Already out' };
    a.outs.add(managerId);
    this.io.emit('lotPass', { manager: m.name });
    this.resolveEarly();
    return { ok: true };
  }

  // if nobody can outbid the current state, settle the lot immediately
  resolveEarly() {
    const a = this.auction;
    if (!a || !a.current) return;
    const contenders = this.activeManagers().filter((m) => {
      if (a.outs.has(m.id)) return false;
      if (m.id === a.highBidder) return false;
      if (m.squad.length >= 6) return false;
      if (m.budget < a.highBid + 1) return false;
      if (!this.purchaseLegal(m, a.current.pos)) return false;
      if (a.current.pos === 'GK' && m.squad.some((p) => p.pos === 'GK')) return false;
      return true;
    });
    if (contenders.length === 0) {
      clearTimeout(this.timers.lot);
      this.io.emit('lotSettling', { sold: !!a.highBidder });
      this.nextLot();
    }
  }

  endAuction() {
    this.autoFill(this.auction.unsold);
    this.phase = 'setup';
    this.io.emit('phase', { phase: 'setup' });
    this.requestStarters('first');
  }

  autoFill(unsold) {
    for (const m of this.activeManagers()) {
      while (m.squad.length < 6) {
        const have = m.squad.map((p) => p.pos);
        const missing = ['GK', 'DEF', 'MID', 'ATT'].filter((x) => !have.includes(x));
        const wantPos = missing.length ? missing[0] : null;
        const slotsAfter = 6 - (m.squad.length + 1);
        const hasGK = have.includes('GK');
        const posOk = (pos) => (!wantPos || pos === wantPos) && !(pos === 'GK' && hasGK) && Game.formationFeasible([...have, pos], slotsAfter);
        let cand = unsold.filter((p) => posOk(p.pos) && !this.owned(p.name));
        if (!cand.length) cand = FILLER.filter((p) => posOk(p.pos) && !this.owned(p.name));
        if (!cand.length) cand = FILLER.filter((p) => !(p.pos === 'GK' && hasGK) && Game.formationFeasible([...have, p.pos], slotsAfter) && !this.owned(p.name));
        if (!cand.length) cand = FILLER.filter((p) => !(p.pos === 'GK' && hasGK) && !this.owned(p.name));
        const pickP = E.pick(cand);
        m.squad.push({ ...pickP, seasonMod: 0 });
        m.signings.push({ player: pickP.name, price: 0, window: 'autofill' });
        this.io.emit('autoFill', { manager: m.name, player: pickP.name, pos: pickP.pos });
      }
    }
  }
  owned(name) {
    return this.managers.some((m) => m.squad.some((p) => p.name === name));
  }

  // ---------- starters & formation ----------
  validFormations(m) {
    const avail = m.squad.filter((p) => p.name !== m.injured);
    const count = (pos) => avail.filter((p) => p.pos === pos).length;
    return Object.entries(FORMATIONS)
      .filter(([, f]) => ['GK', 'DEF', 'MID', 'ATT'].every(
        (pos) => count(pos) >= f.slots.filter((s) => s === pos).length
      ))
      .map(([k]) => k);
  }

  requestStarters(half) {
    this.pendingStarters = new Set(this.activeManagers().map((m) => m.id));
    this.io.emit('pickStarters', {
      half,
      deadlineMs: TIMINGS.PICK_STARTERS_MS,
      perManager: this.activeManagers().map((m) => ({
        id: m.id,
        squad: m.squad.map((p) => ({ name: p.name, pos: p.pos, injured: p.name === m.injured })),
        validFormations: this.validFormations(m),
      })),
    });
    clearTimeout(this.timers.starters);
    this.timers.starters = setTimeout(() => this.autoPickRemaining(half), TIMINGS.PICK_STARTERS_MS);
    this.startersHalf = half;
  }

  submitStarters(managerId, formation, starterNames) {
    const m = this.managers.find((x) => x.id === managerId);
    if (!m || !this.pendingStarters || !this.pendingStarters.has(managerId)) return { error: 'Not expected' };
    if (!FORMATIONS[formation]) return { error: 'Bad formation' };
    const players = (starterNames || []).map((nm) => m.squad.find((p) => p.name === nm)).filter(Boolean);
    if (players.length !== 5) return { error: 'Pick exactly 5' };
    if (players.some((p) => p.name === m.injured)) return { error: 'Injured player selected' };
    const need = [...FORMATIONS[formation].slots];
    for (const p of players) {
      const i = need.indexOf(p.pos);
      if (i === -1) return { error: `Doesn't fit ${formation}` };
      need.splice(i, 1);
    }
    m.formation = formation;
    m.starters = players;
    this.pendingStarters.delete(managerId);
    this.io.emit('startersLocked', { manager: m.name });
    this.autoPickIfOnlyGhosts();
    if (this.phase === 'winter' && this.pendingStarters.size > 0) {
      // if everyone left is just spectating the hub, keep them informed who's locked
      this.io.emit('winterUpdate', { review: this.winterPayload().review });
    }
    if (this.pendingStarters.size === 0) this.startersDone();
    return { ok: true };
  }

  suggestXI(managerId) {
    const m = this.managers.find((x) => x.id === managerId);
    if (!m || m.sacked) return { error: 'Not in game' };
    const forms = this.validFormations(m);
    if (!forms.length) return { error: 'No legal formation' };
    let best = null;
    for (const f of forms) {
      const avail = m.squad.filter((p) => p.name !== m.injured);
      const starters = [];
      let ok = true;
      for (const pos of ['GK', 'DEF', 'MID', 'ATT']) {
        const needed = FORMATIONS[f].slots.filter((s) => s === pos).length;
        const ranked = avail.filter((p) => p.pos === pos && !starters.includes(p))
          .sort((x, y) => x.fc26 - y.fc26); // WORST visible XI by design — never leaks engine order
        if (ranked.length < needed) { ok = false; break; }
        starters.push(...ranked.slice(0, needed));
      }
      if (!ok) continue;
      const score = starters.reduce((s, p) => s + p.fc26, 0);
      if (!best || score < best.score) best = { score, formation: f, starters: starters.map((p) => p.name) };
    }
    if (!best) return { error: 'No legal formation' };
    return { ok: true, formation: best.formation, starters: best.starters };
  }

  autoPickIfOnlyGhosts() {
    if (!this.pendingStarters || this.pendingStarters.size === 0) return;
    const pendingConnected = [...this.pendingStarters].some((id) => {
      const m = this.managers.find((x) => x.id === id);
      return m && m.connected;
    });
    if (!pendingConnected) this.autoPickRemaining(this.startersHalf);
  }

  autoPickRemaining(half) {
    for (const id of [...(this.pendingStarters || [])]) {
      const m = this.managers.find((x) => x.id === id);
      const forms = this.validFormations(m);
      const f = forms.includes('BAL') ? 'BAL' : forms[0];
      const avail = m.squad.filter((p) => p.name !== m.injured);
      const starters = [];
      for (const pos of ['GK', 'DEF', 'MID', 'ATT']) {
        const needed = FORMATIONS[f].slots.filter((s) => s === pos).length;
        const cand = E.shuffle(avail.filter((p) => p.pos === pos && !starters.includes(p)));
        starters.push(...cand.slice(0, needed));
      }
      m.formation = f;
      m.starters = starters;
      this.pendingStarters.delete(id);
      this.io.emit('startersLocked', { manager: m.name, auto: true });
    }
    this.startersDone();
  }

  startersDone() {
    clearTimeout(this.timers.starters);
    if (this.startersHalf === 'first') this.startSeason();
    else this.startSecondHalf();
  }

  // ---------- season ----------
  startSeason() {
    for (const m of this.activeManagers()) for (const p of m.squad) p.seasonMod = E.rollSeasonEvent();
    const n = this.managers.length;
    const humanTeams = this.managers.map((m, i) => ({ type: 'human', mIdx: i, name: m.club }));
    const strengths = this.managers.map((m) => E.teamStrength(m.starters, m.formation));
    const avg = strengths.reduce((s, t) => s + (t.attack + t.defence) / 2, 0) / n;
    const ais = E.aiStrengths(n, avg, 12 - n).map((s, i) => ({ type: 'ai', name: AI_CLUB_NAMES[i], ...s }));
    this.season = {
      teams: [...humanTeams, ...ais],
      fixtures: E.buildFixtures(12),
      pts: Array(12).fill(0), gf: Array(12).fill(0), ga: Array(12).fill(0),
      w: Array(12).fill(0), d: Array(12).fill(0), l: Array(12).fill(0),
      playerStats: {},
      results: [],
    };
    this.phase = 'firstHalf';
    this.io.emit('phase', { phase: 'firstHalf' });
    this.revealHalf(0, 11, () => this.startWinter());
  }

  teamStrengthNow(t) {
    if (t.type === 'ai') return { attack: t.attack + (t.comeback || 0), defence: t.defence + (t.comeback || 0) };
    const m = this.managers[t.mIdx];
    const s = E.teamStrength(m.starters, m.formation);
    return { attack: s.attack + (t.comeback || 0), defence: s.defence + (t.comeback || 0) };
  }

  simMatchday(md) {
    const out = [];
    for (const [a, b] of this.season.fixtures[md]) {
      const TA = this.season.teams[a], TB = this.season.teams[b];
      const r = E.playMatch(this.teamStrengthNow(TA), this.teamStrengthNow(TB));
      let detail = null;
      const sA = TA.type === 'human' ? this.managers[TA.mIdx].starters : null;
      const sB = TB.type === 'human' ? this.managers[TB.mIdx].starters : null;
      if (sA || sB) {
        detail = E.buildCommentary(r, sA || [{ name: TA.name, pos: 'ATT', rating: 80 }], sB || [{ name: TB.name, pos: 'ATT', rating: 80 }]);
        for (const s of detail.scorersA) if (sA) this.bumpStat(s.name, s.assist);
        for (const s of detail.scorersB) if (sB) this.bumpStat(s.name, s.assist);
      }
      this.season.gf[a] += r.goalsA; this.season.ga[a] += r.goalsB;
      this.season.gf[b] += r.goalsB; this.season.ga[b] += r.goalsA;
      if (r.goalsA > r.goalsB) { this.season.pts[a] += 3; this.season.w[a]++; this.season.l[b]++; }
      else if (r.goalsA < r.goalsB) { this.season.pts[b] += 3; this.season.w[b]++; this.season.l[a]++; }
      else { this.season.pts[a]++; this.season.pts[b]++; this.season.d[a]++; this.season.d[b]++; }
      out.push({ md, a, b, ...r, detail, humans: (sA ? 1 : 0) + (sB ? 1 : 0) });
    }
    return out;
  }
  bumpStat(name, assist) {
    const st = (this.season.playerStats[name] ||= { goals: 0, assists: 0 });
    st.goals++;
    if (assist) {
      const at = (this.season.playerStats[assist] ||= { goals: 0, assists: 0 });
      at.assists++;
    }
  }

  table() {
    return this.season.teams
      .map((t, i) => ({
        name: t.name, type: t.type,
        manager: t.type === 'human' ? this.managers[t.mIdx].name : null,
        sacked: t.type === 'human' ? this.managers[t.mIdx].sacked : false,
        pts: this.season.pts[i], gf: this.season.gf[i], ga: this.season.ga[i], gd: this.season.gf[i] - this.season.ga[i],
        w: this.season.w[i], d: this.season.d[i], l: this.season.l[i],
      }))
      .sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf);
  }

  revealHalf(fromMd, toMd, done) {
    const queue = [];
    for (let md = fromMd; md < toMd; md++) {
      const results = this.simMatchday(md);
      for (const r of results) if (r.humans > 0) queue.push(r);
      queue.push({ tableMark: true, md });
    }
    const finalTable = this.table();
    this.reveal = { queue, i: 0, done, finalTable, waiting: false, last: null };
    this.revealStep();
  }

  revealStep() {
    const R = this.reveal;
    if (!R) return;
    if (this.paused) { this.timers.reveal = setTimeout(() => this.revealStep(), 500); return; }
    while (R.i < R.queue.length && R.queue[R.i].tableMark) {
      this.io.emit('tableUpdate', { afterMatchday: R.queue[R.i].md + 1 });
      R.i++;
    }
    if (R.i >= R.queue.length) {
      const doneFn = R.done;
      this.io.emit('halfDone', { table: R.finalTable });
      this.reveal = null;
      return doneFn();
    }
    const item = R.queue[R.i];
    const host = this.managers.find((m) => m.id === this.hostId);
    R.last = {
      matchday: item.md + 1,
      home: this.season.teams[item.a].name,
      away: this.season.teams[item.b].name,
      score: [item.goalsA, item.goalsB],
      events: item.detail ? item.detail.events : [],
      featured: item.humans === 2,
      hostName: host ? host.name : 'Host',
    };
    R.waiting = true;
    this.io.emit('matchReveal', R.last);
    if (FAST) this.timers.reveal = setTimeout(() => this.hostAdvanceReveal(this.hostId), 10);
  }

  hostAdvanceReveal(managerId) {
    if (managerId !== this.hostId) return { error: 'Host only' };
    const R = this.reveal;
    if (!R || !R.waiting) return { error: 'Nothing to advance' };
    R.waiting = false;
    R.i++;
    this.revealStep();
    return { ok: true };
  }

  // ---------- winter: review + respins (no second auction) ----------
  playerForm(p) {
    const st = this.season.playerStats[p.name] || { goals: 0, assists: 0 };
    const eff = p.rating + p.seasonMod;
    let form = 5.5 + p.seasonMod * 0.45 + (eff - 83) * 0.15 + st.goals * 0.35 + st.assists * 0.2 + E.gauss(0, 0.7);
    return Math.round(E.clamp(form, 1, 10) * 10) / 10;
  }

  // unit scores from PERFORMANCE (form), never raw engine ratings
  unitScores(m) {
    const formOf = (poss) => {
      const ps = m.squad.filter((p) => poss.includes(p.pos) && p.winterForm != null);
      if (!ps.length) return null;
      return Math.round((ps.reduce((s, p) => s + p.winterForm, 0) / ps.length) * 10) / 10;
    };
    return { def: formOf(['GK', 'DEF']), mid: formOf(['MID']), att: formOf(['ATT']) };
  }

  seasonStats() {
    const ownedBy = {};
    for (const m of this.managers) for (const p of m.squad) ownedBy[p.name] = m.club;
    const rows = Object.entries(this.season.playerStats)
      .map(([name, st]) => ({ name, goals: st.goals, assists: st.assists, owner: ownedBy[name] || null }));
    return {
      topScorers: [...rows].sort((a, b) => b.goals - a.goals || b.assists - a.assists).slice(0, 8).filter((r) => r.goals > 0),
      topAssists: [...rows].sort((a, b) => b.assists - a.assists || b.goals - a.goals).slice(0, 8).filter((r) => r.assists > 0),
    };
  }

  winterPayload() {
    return {
      table: this.table(),
      stats: this.seasonStats(),
      spins: this.spinLog || [],
      injuries: this.winterInjuries,
      sackings: this.winterSackings,
      review: this.activeManagers().map((m) => ({
        id: m.id,
        manager: m.name,
        club: m.club,
        spinsLeft: m.spinsLeft,
        locked: this.pendingStarters ? !this.pendingStarters.has(m.id) : false,
        units: this.unitScores(m),
        validFormations: this.validFormations(m),
        players: m.squad.map((p) => ({
          name: p.name, pos: p.pos, legend: !!p.legend,
          form: p.winterForm != null ? p.winterForm : null, // null = arrived after the half (respin)
          goals: (this.season.playerStats[p.name] || {}).goals || 0,
          assists: (this.season.playerStats[p.name] || {}).assists || 0,
          injured: p.name === m.injured,
        })),
      })),
    };
  }

  startWinter() {
    this.phase = 'winter';
    const table = this.table();
    for (const m of this.activeManagers()) {
      m.spinsLeft = 5;
      for (const p of m.squad) p.winterForm = this.playerForm(p);
    }
    this.winterInjuries = [];
    for (const m of this.activeManagers()) {
      if (Math.random() < 0.25) {
        const ranked = [...m.squad].sort((a, b) => (b.rating + b.seasonMod) - (a.rating + a.seasonMod));
        const fieldableWithout = (name) => Game.formationFeasible(m.squad.filter((p) => p.name !== name).map((p) => p.pos), 0);
        const victim = ranked.find((p) => fieldableWithout(p.name));
        if (victim) {
          m.injured = victim.name;
          this.winterInjuries.push({ manager: m.name, player: victim.name });
        }
      }
    }
    this.winterSackings = [];
    if (this.activeManagers().length >= 4) {
      const humanRows = table.filter((r) => r.type === 'human' && !r.sacked);
      const lowestHuman = humanRows[humanRows.length - 1];
      const posOf = table.findIndex((r) => r.name === lowestHuman.name);
      const safetyPts = table[table.length - 4].pts;
      if (posOf >= 9 && lowestHuman.pts <= safetyPts - 6) {
        const m = this.managers.find((x) => x.name === lowestHuman.manager);
        m.sacked = true;
        const ti = this.season.teams.findIndex((t) => t.type === 'human' && this.managers[t.mIdx].name === m.name);
        const s = E.teamStrength(m.starters, m.formation);
        this.season.teams[ti] = { type: 'ai', name: this.season.teams[ti].name, attack: s.attack, defence: s.defence };
        this.winterSackings.push({ manager: m.name, club: lowestHuman.name });
      }
    }
    table.forEach((row, idx) => {
      const pos = idx + 1;
      if (pos >= 6 && pos <= 9) {
        const ti = this.season.teams.findIndex((t) => t.name === row.name);
        this.season.teams[ti].comeback = E.PARAMS.COMEBACK;
      }
    });
    // lock-in flow: winter hub doubles as second-half team selection
    this.startersHalf = 'second';
    this.pendingStarters = new Set(this.activeManagers().map((m) => m.id));
    this.spinLog = [];
    this.io.emit('winter', this.winterPayload());
    clearTimeout(this.timers.starters);
    this.timers.starters = setTimeout(() => this.autoPickRemaining('second'), TIMINGS.WINTER_FALLBACK_MS);
  }

  // ---------- respins ----------
  respin(managerId, playerName) {
    if (this.phase !== 'winter') return { error: 'No respins right now' };
    const m = this.managers.find((x) => x.id === managerId);
    if (!m || m.sacked) return { error: 'Not in game' };
    if (!this.pendingStarters.has(m.id)) return { error: 'Already locked in' };
    if ((m.spinsLeft || 0) <= 0) return { error: 'No respins left' };
    const old = m.squad.find((p) => p.name === playerName);
    if (!old) return { error: 'Not your player' };
    const pos = old.pos;
    const roll = Math.random();
    let tier, repl;
    const candidates = (lo, hi, set) =>
      E.shuffle((set || ALL_PLAYERS).filter((p) => p.pos === pos && p.fc26 >= lo && p.fc26 <= hi && !this.owned(p.name) && !LEGENDS.some((l) => l.name === p.name)));
    const bandPick = (lo, hi) => {
      // widen the band step by step if no unowned player exists in it
      for (let w = 0; w < 8 && !repl; w++) repl = candidates(Math.max(60, lo - w), Math.min(94, hi + w))[0];
    };
    if (roll < 0.40) { tier = 'worse'; bandPick(old.fc26 - 5, old.fc26 - 2); }
    else if (roll < 0.70) { tier = 'better'; bandPick(old.fc26 + 1, old.fc26 + 2); }
    else if (roll < 0.95) { tier = 'great'; bandPick(Math.min(old.fc26 + 3, 90), Math.min(old.fc26 + 5, 90)); }
    else {
      tier = 'legend';
      repl = E.shuffle(LEGENDS.filter((l) => l.pos === pos && !this.owned(l.name)))[0];
      if (!repl) { tier = 'great'; bandPick(Math.min(old.fc26 + 3, 90), Math.min(old.fc26 + 5, 90)); }
    }
    if (!repl) repl = candidates(60, 94)[0];
    if (!repl) return { error: 'No replacement available' };
    // swap: new player has no first-half history; seasonMod rolled at second-half start
    const idx = m.squad.indexOf(old);
    m.squad[idx] = { ...repl, winterForm: null };
    if (m.injured === old.name) m.injured = null;
    m.spinsLeft--;
    this.spinLog.push({ manager: m.name, oldPlayer: old.name, newPlayer: repl.name, tier });
    this.io.emit('respinResult', {
      manager: m.name,
      oldPlayer: { name: old.name, pos },
      newPlayer: { name: repl.name, pos: repl.pos, legend: !!repl.legend },
      tier,
      spinsLeft: m.spinsLeft,
      review: this.winterPayload().review,
      spins: this.spinLog,
    });
    return { ok: true };
  }


  startSecondHalf() {
    for (const m of this.activeManagers()) for (const p of m.squad) if (p.seasonMod === undefined) p.seasonMod = E.rollSeasonEvent();
    this.phase = 'secondHalf';
    this.io.emit('phase', { phase: 'secondHalf' });
    this.revealHalf(11, 22, () => this.finish());
  }

  // ---------- finish & awards ----------
  finish() {
    this.phase = 'finished';
    const table = this.table();
    const stats = this.season.playerStats;
    const ownedBy = {};
    for (const m of this.managers) for (const p of m.squad) ownedBy[p.name] = m.name;
    const entries = Object.entries(stats).filter(([nm]) => ownedBy[nm]);
    const topGoals = [...entries].sort((a, b) => b[1].goals - a[1].goals)[0];
    const topAssists = [...entries].sort((a, b) => b[1].assists - a[1].assists)[0];
    const allSignings = [];
    for (const m of this.managers) for (const s of m.signings) {
      const p = m.squad.find((x) => x.name === s.player);
      if (!p) continue;
      const st = stats[p.name] || { goals: 0, assists: 0 };
      const value = p.rating + p.seasonMod + st.goals * 1.5 + st.assists;
      allSignings.push({ ...s, manager: m.name, value, eff: p.rating + p.seasonMod });
    }
    const paid = allSignings.filter((s) => s.price > 0);
    const bestSigning = [...paid].sort((a, b) => b.value - a.value)[0];
    const bestBargain = [...paid].filter((s) => s.eff >= 84).sort((a, b) => a.price - b.price)[0];
    const biggestFlop = [...paid].sort((a, b) => (b.price - b.value) - (a.price - a.value))[0];
    const spinRank = { legend: 3, great: 2, better: 1, worse: 0 };
    const bestSpin = [...(this.spinLog || [])].sort((a, b) => spinRank[b.tier] - spinRank[a.tier])[0];
    this.io.emit('finished', {
      table,
      stats: this.seasonStats(),
      champion: table[0],
      awards: {
        goldenBoot: topGoals ? { player: topGoals[0], goals: topGoals[1].goals, owner: ownedBy[topGoals[0]] } : null,
        mostAssists: topAssists ? { player: topAssists[0], assists: topAssists[1].assists, owner: ownedBy[topAssists[0]] } : null,
        bestSigning: bestSigning ? { player: bestSigning.player, price: bestSigning.price, manager: bestSigning.manager } : null,
        bestBargain: bestBargain ? { player: bestBargain.player, price: bestBargain.price, manager: bestBargain.manager } : null,
        biggestFlop: biggestFlop ? { player: biggestFlop.player, price: biggestFlop.price, manager: biggestFlop.manager } : null,
        spinOfSeason: bestSpin && spinRank[bestSpin.tier] >= 2 ? bestSpin : null,
      },
    });
  }

  // ---------- connection handling ----------
  broadcastBudgets() {
    this.io.emit('budgets', this.activeManagers().map((m) => ({
      name: m.name, budget: m.budget,
      squadCount: m.squad.length,
      done: m.squad.length >= 6,
    })));
  }

  setConnected(id, connected) {
    const m = this.managers.find((x) => x.id === id);
    if (!m) return;
    m.connected = connected;
    if (this.phase === 'lobby') {
      if (!connected) this.managers = this.managers.filter((x) => x.id !== id);
      if (this.hostId === id && this.managers.length) this.hostId = this.managers[0].id;
      this.broadcastLobby();
      return;
    }
    if (!connected && m.id === this.hostId) {
      const next = this.managers.find((x) => x.connected && !x.sacked && x.id !== m.id);
      if (next) {
        this.hostId = next.id;
        this.io.emit('hostChanged', { hostId: next.id, name: next.name });
        if (this.phase === 'auction' && this.auction && !this.auction.current && !this.paused) {
          this.io.emit('awaitNext', { hostName: next.name });
        }
        if (this.reveal && this.reveal.waiting && this.reveal.last) {
          this.reveal.last.hostName = next.name;
          this.io.emit('matchReveal', this.reveal.last);
        }
      }
    }
    if (!connected && (this.phase === 'setup' || this.phase === 'winter')) this.autoPickIfOnlyGhosts();
    const inAuction = this.phase === 'auction';
    if (!connected && inAuction && !m.sacked) {
      this.paused = true;
      this.pausedAt = Date.now();
      this.io.emit('paused', { manager: m.name, maxMs: TIMINGS.DISCONNECT_PAUSE_MS });
      clearTimeout(this.timers.lot);
      clearTimeout(this.timers.pause);
      this.timers.pause = setTimeout(() => this.resume(), TIMINGS.DISCONNECT_PAUSE_MS);
    }
    if (connected && this.paused) this.resume();
  }

  hostPause(managerId) {
    if (managerId !== this.hostId) return { error: 'Host only' };
    if (this.phase !== 'auction') return { error: 'No auction running' };
    if (this.paused) return { error: 'Already paused' };
    this.paused = true;
    this.pausedAt = Date.now();
    this.hostPaused = true;
    clearTimeout(this.timers.lot);
    this.io.emit('paused', { manager: 'Host', byHost: true });
    return { ok: true };
  }

  hostResume(managerId) {
    if (managerId !== this.hostId) return { error: 'Host only' };
    if (!this.paused) return { error: 'Not paused' };
    this.hostPaused = false;
    this.resume();
    return { ok: true };
  }

  resume() {
    if (!this.paused) return;
    clearTimeout(this.timers.pause);
    const pausedFor = Date.now() - this.pausedAt;
    this.paused = false;
    if (this.auction && this.auction.current) {
      this.auction.deadline += pausedFor;
      this.io.emit('resumed', { deadline: this.auction.deadline });
      this.armLotTimer();
    } else {
      this.io.emit('resumed', {});
    }
  }

  snapshot(forId) {
    return {
      code: this.code, phase: this.phase, hostId: this.hostId, speed: this.speed,
      managers: this.managers.map((m) => ({
        id: m.id, name: m.name, club: m.club, ready: m.ready, budget: m.budget,
        squad: m.id === forId ? m.squad.map((p) => ({ name: p.name, pos: p.pos })) : { count: m.squad.length },
        sacked: m.sacked, injured: m.injured,
      })),
      auction: this.auction && this.auction.current ? {
        window: this.auction.window,
        player: { name: this.auction.current.name, pos: this.auction.current.pos },
        highBid: this.auction.highBid,
        highBidder: this.auction.highBidder ? (this.managers.find((x) => x.id === this.auction.highBidder) || {}).name : null,
        deadline: this.auction.deadline,
        index: this.auction.index, total: this.auction.queue.length,
      } : null,
      table: this.season ? this.table() : null,
      winter: this.phase === 'winter' ? this.winterPayload() : null,
      paused: this.paused,
    };
  }
}

module.exports = { Game, FORMATIONS, TIMINGS, mid };
