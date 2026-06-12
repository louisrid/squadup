// Game state machine. One Game instance per lobby. Server-authoritative.
// Pool selection uses FC26 ratings ONLY. Engine ratings are used solely for
// match simulation, form scores, injuries and awards — never for what appears at auction.
const E = require('./engine');
const ALL_PLAYERS = require('./data/players.json');

const FILLER = ALL_PLAYERS.filter((p) => p.fc26 < 84);

// Legends: winter-market exclusives. FC26 95, white/gold cards. Max 2 per window.
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
  'Kings Heath FC', 'Donkey United', 'Norfield Athletic', 'Saltway Wanderers',
  'Dunmore FC', 'Westcliff Albion',
];

const FORMATIONS = {
  DEF: { slots: ['GK', 'DEF', 'DEF', 'MID', 'ATT'], label: 'Defensive' },
  BAL: { slots: ['GK', 'DEF', 'MID', 'MID', 'ATT'], label: 'Balanced' },
  MID: { slots: ['GK', 'DEF', 'MID', 'MID', 'MID'], label: 'Midfield' },
  ATT: { slots: ['GK', 'DEF', 'MID', 'ATT', 'ATT'], label: 'Attacking' },
};

const FAST = process.env.FAST === '1';
const TIMINGS = {
  AUCTION_START_MS: FAST ? 150 : 16000,
  AUCTION_BID_ADD_MS: FAST ? 60 : 3000,
  AUCTION_MAX_MS: FAST ? 600 : 12000,
  AUCTION_BETWEEN_MS: FAST ? 30 : 4000,
  LOT_REVEAL_MS: FAST ? 20 : 4400,
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
    this.speed = 2; // host toggle: 1x or 2x auction pace (2x is the default)
    this.showHints = false; // host option: show fuzzy FC26 ranges on cards
    this.hints = {};
  }

  sp(ms) { return Math.round(ms / this.speed); }

  hintFor(p) {
    if (!this.showHints) return undefined;
    if (!this.hints[p.name]) {
      const lo = p.rating - (1 + Math.floor(Math.random() * 2));
      const hi = p.rating + (1 + Math.floor(Math.random() * 2));
      this.hints[p.name] = lo + '–' + hi;
    }
    return this.hints[p.name];
  }

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
      managers: this.managers.map((m) => ({ id: m.id, name: m.name, club: m.club, ready: m.ready, connected: m.connected })),
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
    // 7 lots per manager. Tier mix BY TRUE RATING: n stars (88+), n good (86-87), 5n mid (82-85).
    // EXACT position quotas so every squad need is structurally covered:
    const posQuota = { GK: n + 1, DEF: 2 * n, MID: 2 * n, ATT: 2 * n - 1 }; // sums to 7n
    const stars = Math.max(2, n - 1); // always at least two 90+ headliners, scales with lobby size
    const S = 7 * n;
    const cElite = Math.max(2, Math.round(0.12 * S)); // always at least two 90+
    const cHigh = Math.round(0.22 * S);               // 87-89
    const cGood = Math.round(0.25 * S);               // 85-86
    const cMid = Math.round(0.27 * S);                // 82-84
    const tiers = [
      { lo: 90, hi: 99, count: cElite },
      { lo: 87, hi: 89, count: cHigh },
      { lo: 85, hi: 86, count: cGood },
      { lo: 82, hi: 84, count: cMid },
      { lo: 80, hi: 81, count: S - cElite - cHigh - cGood - cMid },
    ];
    const pool = [];
    const inPool = new Set();
    for (const t of tiers) {
      const cand = E.shuffle(ALL_PLAYERS.filter((p) => p.rating >= t.lo && p.rating <= t.hi && !inPool.has(p.name)));
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
        const tier = tiers.find((t) => victim.rating >= t.lo && victim.rating <= t.hi);
        let repl = E.shuffle(ALL_PLAYERS.filter((p) => p.pos === pos && p.rating >= tier.lo && p.rating <= tier.hi && !inPool.has(p.name)))[0];
        if (!repl) repl = E.shuffle(ALL_PLAYERS.filter((p) => p.pos === pos && p.rating >= 80 && !inPool.has(p.name)))[0];
        if (!repl) break;
        inPool.delete(victim.name); inPool.add(repl.name);
        pool[pool.indexOf(victim)] = repl;
      }
    }
    // top up: never fewer than the guaranteed number of 90+ headliners
    {
      let have90 = pool.filter((p) => p.rating >= 90).length;
      let guard = 0;
      while (have90 < stars && guard++ < 30) {
        const victim = E.shuffle(pool.filter((p) => p.rating <= 85 && !p.wonderkid))[0];
        if (!victim) break;
        const sub = E.shuffle(ALL_PLAYERS.filter((p) => p.pos === victim.pos && p.rating >= 90 && !p.wonderkid && !inPool.has(p.name) && !this.owned(p.name)))[0];
        if (!sub) break;
        inPool.delete(victim.name); inPool.add(sub.name);
        pool[pool.indexOf(victim)] = sub; have90++;
      }
    }
    // exactly 1 wonderkid 60% of the time, 2 otherwise — never more
    const wantWk = Math.random() < 0.6 ? 1 : 2;
    let haveWk = pool.filter((p) => p.wonderkid).length;
    while (haveWk > wantWk) {
      const wk = pool.find((p) => p.wonderkid);
      const swap = E.shuffle(ALL_PLAYERS.filter((p) => !p.wonderkid && p.pos === wk.pos && p.rating >= 82 && p.rating <= 85 && !inPool.has(p.name) && !this.owned(p.name)))[0];
      if (!swap) break;
      inPool.delete(wk.name); inPool.add(swap.name);
      pool[pool.indexOf(wk)] = swap; haveWk--;
    }
    if (haveWk < wantWk) {
      const cand = E.shuffle(ALL_PLAYERS.filter((p) => p.wonderkid && !inPool.has(p.name) && !this.owned(p.name)));
      for (const wk of cand) {
        if (haveWk >= wantWk) break;
        const victim = E.shuffle(pool.filter((p) => p.pos === wk.pos && !p.wonderkid && p.rating < 90))[0] || E.shuffle(pool.filter((p) => !p.wonderkid && p.pos !== 'GK' && p.rating < 90))[0];
        if (!victim) break;
        inPool.delete(victim.name); inPool.add(wk.name);
        pool[pool.indexOf(victim)] = wk;
        haveWk++;
      }
    }
    // first two lots: never wonderkids, rating ≤ 85
    pool.sort((a, b) => a.rating - b.rating);
    const openers = pool.filter((p) => !p.wonderkid && p.rating <= 85).slice(0, 2);
    let rest = E.shuffle(pool.filter((p) => !openers.includes(p)));
    for (let i = 1; i < rest.length; i++) {
      if (rest[i].wonderkid && rest[i - 1].wonderkid) {
        const j = rest.findIndex((p, k) => k > i && !p.wonderkid);
        if (j > 0) { const t = rest[i]; rest[i] = rest[j]; rest[j] = t; }
      }
    }
    return [...openers, ...rest];
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
    this.io.emit('phase', { phase: 'auction', window: 'main', poolSize: pool.length, managerCount: this.managers.length });
    this.nextLot();
  }

  static formationFeasible(positions, slotsLeft) {
    const gks = positions.filter((p) => p === 'GK').length;
    if (gks > 1) return false;               // never more than one keeper
    return gks === 1 || slotsLeft >= 1;      // must still be able to land a keeper
  }

  purchaseLegal(m, pos) {
    return !(pos === 'GK' && m.squad.some((p) => p.pos === 'GK')); // only the keeper cap remains
  }

  activeManagers() {
    return this.managers.filter((m) => !m.sacked);
  }

  nextLot() {
    if (this.paused) return; // nothing settles while paused — resume re-arms the clock
    clearTimeout(this.timers.lot);
    const a = this.auction;
    if (a.current) {
      if (a.highBidder) {
        const m = this.managers.find((x) => x.id === a.highBidder);
        m.budget -= a.highBid;
        m.squad.push({ ...a.current, seasonMod: 0 });
        m.signings.push({ player: a.current.name, price: a.highBid, window: a.window });
        this.io.emit('lotSold', { player: a.current.name, pos: a.current.pos, price: a.highBid, manager: m.name, rtg: a.current.rating, wonderkid: !!a.current.wonderkid });
      } else {
        a.unsold.push(a.current);
        this.io.emit('lotUnsold', { player: a.current.name });
      }
      this.broadcastBudgets();
    }
    const buyers = this.activeManagers().filter((m) => m.budget >= 1);
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
    if (m.sacked || m.budget < 1) return false;
    if (p.pos === 'GK' && m.squad.some((x) => x.pos === 'GK')) return false;
    return true;
  }

  hostNextLot(managerId) {
    if (managerId !== this.hostId) return { error: 'Host only' };
    if (this.paused) return { error: 'Auction is paused' };
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
    a.revealUntil = Date.now() + this.sp(TIMINGS.LOT_REVEAL_MS);
    this.io.emit('lotReveal', {
      index: a.index, total: a.queue.length,
      player: { name: a.current.name, pos: a.current.pos, hint: a.window === 'winter' ? String(a.current.rating) : this.hintFor(a.current), wonderkid: !!a.current.wonderkid, legend: !!a.current.legend },
      revealMs: this.sp(TIMINGS.LOT_REVEAL_MS),
    });
    setTimeout(() => {
      if (!a.current) return;
      a.deadline = Date.now() + this.sp(TIMINGS.AUCTION_START_MS);
      a.revealUntil = 0;
      this.io.emit('lot', {
        index: a.index, total: a.queue.length,
        player: { name: a.current.name, pos: a.current.pos, hint: a.window === 'winter' ? String(a.current.rating) : this.hintFor(a.current), wonderkid: !!a.current.wonderkid, legend: !!a.current.legend },
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
    if (a.current.pos === 'GK' && m.squad.some((p) => p.pos === 'GK')) return { error: 'You already have a keeper' };
    if (a.outs.has(m.id)) return { error: 'You gave up on this lot' };
    a.highBid = amount;
    a.highBidder = m.id;
    // +3s per bid, but the clock can never exceed a 12s ceiling (and never shrinks)
    a.deadline = Math.max(a.deadline, Math.min(a.deadline + this.sp(TIMINGS.AUCTION_BID_ADD_MS), Date.now() + this.sp(TIMINGS.AUCTION_MAX_MS)));
    this.io.emit('bid', { player: a.current.name, amount, manager: m.name, deadline: a.deadline });
    this.armLotTimer();
    this.resolveEarly();
    return { ok: true };
  }

  passLot(managerId) {
    const a = this.auction;
    if (!a || !a.current || this.paused) return { error: this.paused ? 'Auction is paused' : 'No live lot' };
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
    if (!a || !a.current || this.paused) return;
    const contenders = this.activeManagers().filter((m) => {
      if (a.outs.has(m.id)) return false;
      if (m.id === a.highBidder) return false;
      if (m.budget < a.highBid + 1) return false;
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
    this.auction.current = null; // never let a finished lot leak into snapshots
    if (this.auction.window === 'winter') {
      this.phase = 'setup';
      this.io.emit('phase', { phase: 'setup' });
      this.requestStarters('second');
      return;
    }
    this.ensureKeepers(this.auction.unsold);
    this.phase = 'setup';
    this.io.emit('phase', { phase: 'setup' });
    this.requestStarters('first');
  }

  ensureKeepers(unsold) {
    // every manager must leave the window able to field a five: 1 GK + at least 1 DEF/MID/ATT + 5 total
    for (const m of this.activeManagers()) {
      const grant = (pos) => {
        let p = (unsold || []).find((x) => (!pos || x.pos === pos) && x.pos !== 'GK' === (pos !== 'GK') && !this.owned(x.name));
        if (!p) p = FILLER.find((x) => (!pos || x.pos === pos) && !this.owned(x.name));
        if (!p && pos === 'GK') p = { name: 'Youth Keeper', pos: 'GK', fc26: 72, rating: 72 };
        if (!p) p = FILLER.find((x) => x.pos !== 'GK' && !this.owned(x.name)) || { name: 'Youth Prospect', pos: 'MID', fc26: 70, rating: 70 };
        m.squad.push({ ...p, seasonMod: 0 });
        m.signings.push({ player: p.name, price: 0, window: 'freebie' });
        this.io.emit('autoFill', { manager: m.name, player: p.name, pos: p.pos });
      };
      if (!m.squad.some((p) => p.pos === 'GK')) grant('GK');
      for (const pos of ['DEF', 'MID', 'ATT']) if (!m.squad.some((p) => p.pos === pos)) grant(pos);
      let guard = 0;
      while (m.squad.length < 5 && guard++ < 10) grant(null);
    }
  }

  owned(name) {
    return this.managers.some((m) => m.squad.some((p) => p.name === name));
  }

  // ---------- starters & formation ----------
  validFormations() { return ['FREE']; } // XI is free-form: 1 GK + any 4 outfield

  static deriveStyle(starters) {
    const c = { DEF: 0, MID: 0, ATT: 0 };
    for (const p of starters) if (c[p.pos] !== undefined) c[p.pos]++;
    if (c.DEF >= 3) return 'DEF';
    if (c.ATT >= 3) return 'ATT';
    return 'BAL';
  }

  requestStarters(half) {
    this.pendingStarters = new Set(this.activeManagers().map((m) => m.id));
    this.io.emit('pickStarters', {
      half,
      deadlineMs: null, // no time limit on squad assembly
      perManager: this.activeManagers().map((m) => ({
        id: m.id,
        squad: m.squad.map((p) => ({ name: p.name, pos: p.pos, injured: p.name === m.injured, rtg: p.rating, wonderkid: !!p.wonderkid, grew: p.grew || 0 })),
      })),
    });
    clearTimeout(this.timers.starters);
    this.startersHalf = half;
  }

  submitStarters(managerId, formation, starterNames) {
    const m = this.managers.find((x) => x.id === managerId);
    if (!m || !this.pendingStarters || !this.pendingStarters.has(managerId)) return { error: 'Not expected' };
    const names = (starterNames || []).filter(Boolean);
    const missing = names.filter((nm) => !m.squad.some((p) => p.name === nm));
    if (missing.length) return { error: 'Not in your squad: ' + missing[0] };
    const players = names.map((nm) => m.squad.find((p) => p.name === nm));
    if (players.length !== 5) return { error: 'Pick exactly 5 (you have ' + players.length + ')' };
    if (new Set(names).size !== 5) return { error: 'Duplicate player picked' };
    if (players.some((p) => p.name === m.injured)) return { error: 'Injured player selected' };
    if (players.filter((p) => p.pos === 'GK').length !== 1) return { error: 'Exactly one keeper' };
    const fit = m.squad.filter((p) => p.name !== m.injured);
    for (const pos of ['DEF', 'MID', 'ATT']) {
      if (fit.some((p) => p.pos === pos) && !players.some((p) => p.pos === pos)) {
        return { error: 'You must field at least one ' + pos };
      }
    }
    m.formation = Game.deriveStyle(players);
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

  static legalFive(avail, ranker) {
    const gk = avail.find((p) => p.pos === 'GK');
    if (!gk) return null;
    const chosen = [gk];
    for (const pos of ['DEF', 'MID', 'ATT']) {
      const c = ranker(avail.filter((p) => p.pos === pos))[0];
      if (c) chosen.push(c);
    }
    const flex = ranker(avail.filter((p) => p.pos !== 'GK' && !chosen.includes(p)));
    while (chosen.length < 5 && flex.length) chosen.push(flex.shift());
    return chosen.length === 5 ? chosen : null;
  }

  suggestXI(managerId) {
    const m = this.managers.find((x) => x.id === managerId);
    if (!m || m.sacked) return { error: 'Not in game' };
    const avail = m.squad.filter((p) => p.name !== m.injured);
    const five = Game.legalFive(avail, (l) => [...l].sort((a, b) => b.rating - a.rating)); // best five by current rating
    if (!five) return { error: 'Not enough players' };
    return { ok: true, formation: 'FREE', starters: five.map((p) => p.name) };
  }

  autoPickIfOnlyGhosts() {
    if (!this.pendingStarters || this.pendingStarters.size === 0) return;
    const pendingConnected = [...this.pendingStarters].some((id) => {
      const m = this.managers.find((x) => x.id === id);
      return m && m.connected;
    });
    if (!pendingConnected) {
      // grace period: a tabbed-out phone is not an abandoned seat
      clearTimeout(this.timers.ghostPick);
      const wait = FAST ? 250 : 60000;
      this.timers.ghostPick = setTimeout(() => {
        if (!this.pendingStarters || this.pendingStarters.size === 0) return;
        const stillGhosts = ![...this.pendingStarters].some((id) => {
          const m = this.managers.find((x) => x.id === id);
          return m && m.connected;
        });
        if (stillGhosts) this.autoPickRemaining(this.startersHalf);
      }, wait);
    }
  }

  autoPickRemaining(half) {
    for (const id of [...(this.pendingStarters || [])]) {
      const m = this.managers.find((x) => x.id === id);
      const avail = m.squad.filter((p) => p.name !== m.injured);
      const starters = Game.legalFive(avail, (l) => E.shuffle([...l])) || avail.slice(0, 5);
      m.formation = Game.deriveStyle(starters);
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
    const ais = E.aiStrengths(n, avg, 12 - n).map((s, i) => {
      const t = { type: 'ai', name: AI_CLUB_NAMES[i], attack: s.attack - 0.5, defence: s.defence - 0.5 };
      if (t.name === 'Eastvale Rovers') { t.attack += 2.6; t.defence += 2.6; t.elite = true; }
      return t;
    });
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
    this.revealHalf(0, 11, () => this.startSpin());
  }

  teamStrengthNow(t, md) {
    if (t.type === 'ai') return { attack: t.attack + (t.comeback || 0), defence: t.defence + (t.comeback || 0) };
    const m = this.managers[t.mIdx];
    this.suspensions = this.suspensions || {};
    const eligible = m.starters.filter((p) => this.suspensions[p.name] !== md);
    const s = E.teamStrength(eligible.length ? eligible : m.starters, m.formation);
    return { attack: s.attack + (t.comeback || 0), defence: s.defence + (t.comeback || 0) };
  }

  suspendedFor(md, ...teams) {
    this.suspensions = this.suspensions || {};
    const out = [];
    for (const t of teams) {
      if (t.type !== 'ai') {
        const m = this.managers[t.mIdx];
        for (const p of m.starters) if (this.suspensions[p.name] === md) out.push(p.name);
      }
    }
    return out;
  }

  simMatchday(md) {
    const out = [];
    for (const [a, b] of this.season.fixtures[md]) {
      const TA = this.season.teams[a], TB = this.season.teams[b];
      const suspended = this.suspendedFor(md, TA, TB);
      let r = E.playMatch(this.teamStrengthNow(TA, md), this.teamStrengthNow(TB, md));
      // Donkey United: loses 85%, but 15% of the time they DEMOLISH whoever they play
      const donkey = TA.name === 'Donkey United' ? 'A' : TB.name === 'Donkey United' ? 'B' : null;
      if (donkey) {
        if (Math.random() < 0.15) {
          const big = 7 + Math.floor(Math.random() * 3), small = Math.floor(Math.random() * 2);
          r = donkey === 'A' ? { ...r, goalsA: big, goalsB: small } : { ...r, goalsA: small, goalsB: big };
        } else {
          const win = 1 + Math.floor(Math.random() * 3), lose = Math.floor(Math.random() * 2);
          r = donkey === 'A' ? { ...r, goalsA: Math.min(r.goalsA, lose), goalsB: Math.max(r.goalsB, win) }
                             : { ...r, goalsB: Math.min(r.goalsB, lose), goalsA: Math.max(r.goalsA, win) };
        }
      }
      let detail = null;
      const sA = TA.type === 'human' ? this.managers[TA.mIdx].starters : null;
      const sB = TB.type === 'human' ? this.managers[TB.mIdx].starters : null;
      if (sA || sB) {
        detail = E.buildCommentary(r, sA || [{ name: TA.name, pos: 'ATT', rating: 80 }], sB || [{ name: TB.name, pos: 'ATT', rating: 80 }], { redA: !!sA, redB: !!sB });
        this.suspensions = this.suspensions || {};
        for (const red of detail.reds || []) {
          if ((red.side === 'A' && sA) || (red.side === 'B' && sB)) this.suspensions[red.name] = md + 1;
        }
        for (const s of detail.scorersA) if (sA && !s.og) this.bumpStat(s.name, s.assist);
        for (const s of detail.scorersB) if (sB && !s.og) this.bumpStat(s.name, s.assist);
      }
      this.season.gf[a] += r.goalsA; this.season.ga[a] += r.goalsB;
      this.season.gf[b] += r.goalsB; this.season.ga[b] += r.goalsA;
      if (r.goalsA > r.goalsB) { this.season.pts[a] += 3; this.season.w[a]++; this.season.l[b]++; }
      else if (r.goalsA < r.goalsB) { this.season.pts[b] += 3; this.season.w[b]++; this.season.l[a]++; }
      else { this.season.pts[a]++; this.season.pts[b]++; this.season.d[a]++; this.season.d[b]++; }
      out.push({ md, a, b, ...r, detail, suspended, humans: (sA ? 1 : 0) + (sB ? 1 : 0) });
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
      homeMgr: this.season.teams[item.a].type === 'human' ? this.managers[this.season.teams[item.a].mIdx].name : null,
      awayMgr: this.season.teams[item.b].type === 'human' ? this.managers[this.season.teams[item.b].mIdx].name : null,
      homePos: this.season.teams[item.a].type === 'ai' ? this.table().findIndex((r) => r.name === this.season.teams[item.a].name) + 1 : null,
      awayPos: this.season.teams[item.b].type === 'ai' ? this.table().findIndex((r) => r.name === this.season.teams[item.b].name) + 1 : null,
      score: [item.goalsA, item.goalsB],
      events: item.detail ? item.detail.events : [],
      suspended: item.suspended || [],
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

  // ---------- halftime spin: every manager spins a unique wheel ----------
  startSpin() {
    this.phase = 'spin';
    const table = this.table();
    const reserved = new Set();
    this.wheels = {};
    this.pendingSpins = new Set(this.activeManagers().map((m) => m.id));
    for (const m of this.activeManagers()) {
      const pos = table.findIndex((r) => r.manager === m.name) + 1;
      this.wheels[m.id] = this.buildWheel(m, pos, reserved);
    }
    this.io.emit('spinWheel', {
      perManager: this.activeManagers().map((m) => ({ id: m.id, name: m.name, segments: this.wheels[m.id].segments })),
    });
  }

  buildWheel(m, pos, reserved) {
    // odds + fallback tier by league position: bottom half / mid table / top two
    const cfg = pos > 6 ? { pSpecial: 0.4, lo: 88, hi: 94 }
            : pos > 2 ? { pSpecial: 0.2, lo: 86, hi: 90 }
                      : { pSpecial: 0.05, lo: 85, hi: 88 };
    const free = (p) => !this.owned(p.name) && !reserved.has(p.name);
    const legends = E.shuffle(LEGENDS.filter((l) => l.pos !== 'GK' && free(l))).slice(0, 1)
      .map((l) => ({ name: l.name, pos: l.pos, rating: 96, kind: 'legend', base: { ...l, rating: 96 } }));
    const wks = E.shuffle(ALL_PLAYERS.filter((p) => p.wonderkid && free(p))).slice(0, 1)
      .map((p) => { const boosted = Math.min(94, p.rating + 6 + Math.floor(Math.random() * 6));
        return { name: p.name, pos: p.pos, rating: boosted, kind: 'wonder', base: { ...p, rating: boosted } }; });
    const specials = [...legends, ...wks];
    const normals = E.shuffle(ALL_PLAYERS.filter((p) => !p.wonderkid && p.pos !== 'GK' && p.rating >= cfg.lo && p.rating <= cfg.hi && free(p)))
      .slice(0, 8 - specials.length)
      .map((p) => ({ name: p.name, pos: p.pos, rating: p.rating, kind: 'normal', base: { ...p } }));
    for (const s of [...specials, ...normals]) reserved.add(s.name);
    return { segments: E.shuffle([...specials, ...normals]), pSpecial: cfg.pSpecial };
  }

  doSpin(managerId) {
    if (this.phase !== 'spin') return { error: 'No spin right now' };
    if (!this.pendingSpins || !this.pendingSpins.has(managerId)) return { error: 'Already spun' };
    const m = this.managers.find((x) => x.id === managerId);
    const wheel = this.wheels[managerId];
    if (!m || !wheel) return { error: 'No wheel' };
    const segs = wheel.segments;
    const specialIdx = segs.map((s, i) => (s.kind !== 'normal' ? i : -1)).filter((i) => i >= 0);
    const normalIdx = segs.map((s, i) => (s.kind === 'normal' ? i : -1)).filter((i) => i >= 0);
    let idx;
    if (specialIdx.length && Math.random() < wheel.pSpecial) idx = E.pick(specialIdx);
    else idx = normalIdx.length ? E.pick(normalIdx) : E.pick(specialIdx);
    const won = segs[idx];
    m.squad.push({ ...won.base, seasonMod: 0 });
    m.signings.push({ player: won.name, price: 0, window: 'wheel' });
    this.pendingSpins.delete(managerId);
    this.io.emit('spinResult', { manager: m.name, player: won.name, pos: won.pos, rating: won.rating, kind: won.kind, index: idx });
    if (this.pendingSpins.size === 0) setTimeout(() => this.startWinter(), FAST ? 50 : 6000);
    else this.autoSpinIfOnlyGhosts();
    return { ok: true, index: idx };
  }

  hostForceSpins(managerId) {
    if (managerId !== this.hostId) return { error: 'Host only' };
    if (this.phase !== 'spin' || !this.pendingSpins || this.pendingSpins.size === 0) return { error: 'Nobody left to spin' };
    for (const id of [...this.pendingSpins]) this.doSpin(id);
    return { ok: true };
  }

  autoSpinIfOnlyGhosts() {
    if (this.phase !== 'spin' || !this.pendingSpins || this.pendingSpins.size === 0) return;
    const anyConnected = [...this.pendingSpins].some((id) => {
      const m = this.managers.find((x) => x.id === id);
      return m && m.connected;
    });
    if (!anyConnected) {
      clearTimeout(this.timers.ghostSpin);
      this.timers.ghostSpin = setTimeout(() => {
        if (this.phase !== 'spin' || !this.pendingSpins) return;
        const still = ![...this.pendingSpins].some((id) => { const m = this.managers.find((x) => x.id === id); return m && m.connected; });
        if (still) for (const id of [...this.pendingSpins]) this.doSpin(id);
      }, FAST ? 250 : 60000);
    }
  }

  // ---------- winter: report + winter market auction + second-half pick ----------
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

  assistantTips(m) {
    const tips = [];
    const fit = m.squad.filter((p) => p.name !== m.injured);
    const unitAvg = (poss) => {
      const ps = fit.filter((p) => poss.includes(p.pos));
      return ps.length ? ps.reduce((s, p) => s + p.rating, 0) / ps.length : 0;
    };
    const units = [['defence', unitAvg(['GK', 'DEF'])], ['midfield', unitAvg(['MID'])], ['attack', unitAvg(['ATT'])]];
    const sorted = [...units].sort((a, b) => a[1] - b[1]);
    const weakest = sorted[0], strongest = sorted[2];
    if (weakest[1] > 0 && (weakest[1] < 84 || strongest[1] - weakest[1] >= 4)) {
      tips.push(`Boss, we need to strengthen our ${weakest[0]} — it's our weakest line at ${Math.round(weakest[1])}.`);
    } else if (weakest[1] >= 86) {
      if (Math.random() < 0.6) tips.push(`Squad's looking sharp across the board, boss. Trust it — or get greedy in the market.`);
    }
    const flop = [...fit].filter((p) => p.winterForm != null).sort((a, b) => a.winterForm - b.winterForm)[0];
    if (flop && flop.winterForm < 5.6) tips.push(`${flop.name} had a shocker of a half (${flop.winterForm.toFixed(1)} form). The market is open, boss…`);
    const star = [...fit].filter((p) => p.winterForm != null).sort((a, b) => b.winterForm - a.winterForm)[0];
    if (star && star.winterForm >= 7.2) tips.push(`${star.name} is carrying us (${star.winterForm.toFixed(1)} form). Build around him.`);
    const wk = fit.find((p) => p.wonderkid && (p.grew || 0) >= 4);
    if (wk) tips.push(`${wk.name} just exploded in training (+${wk.grew}). The boy is special, boss.`);
    if (m.budget >= 90) tips.push(`£${m.budget}m in the bank — that buys anyone in this market. Splash it.`);
    if (m.injured) tips.push(`${m.injured} is out for the season — we play the second half a man lighter unless we buy cover.`);
    return tips.slice(0, 3);
  }

  winterPayload() {
    return {
      table: this.table(),
      stats: this.seasonStats(),
      budgets: this.activeManagers().map((m) => ({ manager: m.name, budget: m.budget })),
      injuries: this.winterInjuries,
      sackings: this.winterSackings,
      review: this.activeManagers().map((m) => ({
        id: m.id,
        manager: m.name,
        club: m.club,
        locked: this.pendingStarters && this.startersHalf === 'second' ? !this.pendingStarters.has(m.id) : false,
        units: this.unitScores(m),
        starters: (m.starters || []).map((p) => p.name),
        tips: this.assistantTips(m),
        validFormations: this.validFormations(m),
        players: m.squad.map((p) => ({
          name: p.name, pos: p.pos, legend: !!p.legend, wonderkid: !!p.wonderkid, rtg: p.rating,
          form: p.winterForm != null ? p.winterForm : null,
          grew: p.grew || 0,
          goals: (this.season.playerStats[p.name] || {}).goals || 0,
          assists: (this.season.playerStats[p.name] || {}).assists || 0,
          injured: p.name === m.injured,
        })),
      })),
    };
  }

  startWinter() {
    if (this.phase === 'winter') return; // idempotent — never double-fire
    this.phase = 'winter';
    const table = this.table();
    for (const m of this.activeManagers()) {
      m.budget += 50; // winter war chest
      for (const p of m.squad) {
        p.winterForm = this.playerForm(p);
        const grew = E.winterGrowth(p, p.winterForm);
        p.rating += grew;
        p.grew = grew; // surfaced in the winter report and second-half pick
      }
    }
    this.winterInjuries = [];
    for (const m of this.activeManagers()) {
      if (Math.random() < 0.25) {
        const ranked = [...m.squad].sort((a, b) => (b.rating + b.seasonMod) - (a.rating + a.seasonMod));
        const victim = ranked.find((p) => p.pos !== 'GK');
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
    // winter report first; host then opens the winter market (auction), then everyone picks
    this.io.emit('winter', this.winterPayload());
    this.broadcastBudgets();
  }

  hostStartWinterAuction(managerId) {
    if (managerId !== this.hostId) return { error: 'Host only' };
    if (this.phase !== 'winter' || this.auction && this.auction.window === 'winter' && this.auction.current !== undefined && this.phase === 'auction') return { error: 'Not now' };
    this.startWinterAuction();
    return { ok: true };
  }

  startWinterAuction() {
    if (this.phase !== 'winter') return;
    this.phase = 'auction';
    const pool = this.buildWinterPool();
    this.auction = {
      window: 'winter', queue: pool, index: -1,
      current: null, highBid: 0, highBidder: null, deadline: 0, unsold: [], outs: new Set(),
    };
    this.io.emit('phase', { phase: 'auction', window: 'winter', poolSize: pool.length, managerCount: this.activeManagers().length });
    this.nextLot();
  }

  buildWinterPool() {
    const n = this.activeManagers().length;
    const total = 3 * n;
    // 60% of windows feature 1 legend, 40% feature 2 — regardless of player count. NEVER keepers.
    const legendCount = Math.random() < 0.6 ? 1 : 2;
    const legends = E.shuffle(LEGENDS.filter((l) => !this.owned(l.name) && l.pos !== 'GK')).slice(0, legendCount).map((l) => ({ ...l, rating: 96, pot: 96 }));
    const restCount = total - legends.length;
    const ok = (p, pos, lo) => p.pos === pos && p.fc26 >= lo && !p.wonderkid && !this.owned(p.name) && !LEGENDS.some((l) => l.name === p.name);
    const fresh = (lo) => ({
      DEF: E.shuffle(ALL_PLAYERS.filter((p) => ok(p, 'DEF', lo))),
      MID: E.shuffle(ALL_PLAYERS.filter((p) => ok(p, 'MID', lo))),
      ATT: E.shuffle(ALL_PLAYERS.filter((p) => ok(p, 'ATT', lo))),
    });
    const byPos = fresh(87);
    const backup = fresh(86);
    const rest = [];
    const order = ['DEF', 'MID', 'ATT'];
    let i = 0, guard = 0;
    while (rest.length < restCount && guard++ < restCount * 6) {
      const pos = order[i++ % 3];
      const p = byPos[pos].shift() || backup[pos].find((x) => !rest.includes(x));
      if (p && !rest.includes(p)) rest.push(p);
    }
    // legends: never lots 1-3, never back-to-back
    const seq = E.shuffle(rest);
    const used = [];
    for (const l of legends) {
      let i, tries = 0;
      do { i = 3 + Math.floor(Math.random() * Math.max(1, seq.length - 2)); tries++; }
      while (tries < 100 && used.some((u) => Math.abs(u - i) <= 1));
      used.push(i);
      seq.splice(Math.min(i, seq.length), 0, l);
    }
    return seq;
  }



  startSecondHalf() {
    for (const m of this.activeManagers()) for (const p of m.squad) if (p.seasonMod === undefined) p.seasonMod = E.rollSeasonEvent();
    // re-anchor AI clubs to the post-winter human level so scorelines stay sane
    const live = this.activeManagers();
    if (live.length) {
      const strengths = live.map((m) => E.teamStrength(m.starters, m.formation));
      const avg = strengths.reduce((s, t) => s + (t.attack + t.defence) / 2, 0) / live.length;
      for (const t of this.season.teams) {
        if (t.type === 'ai' && !t.wasHuman) {
          const base = avg + E.gauss() * 1.1 - 3.0;
          t.attack = base + E.gauss() * 0.6 + (t.elite ? 2.6 : 0);
          t.defence = base + E.gauss() * 0.6 + (t.elite ? 2.6 : 0);
        }
      }
    }
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
    const winterBuys = allSignings.filter((s) => s.window === 'winter' && s.price > 0);
    const winterSplash = [...winterBuys].sort((a, b) => b.price - a.price)[0];
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
        winterSplash: winterSplash ? { player: winterSplash.player, price: winterSplash.price, manager: winterSplash.manager } : null,
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
      this.lobbyDrop = this.lobbyDrop || {};
      if (!connected) {
        clearTimeout(this.lobbyDrop[id]);
        this.lobbyDrop[id] = setTimeout(() => {
          if (this.phase !== 'lobby') return;
          const still = this.managers.find((x) => x.id === id);
          if (!still || still.connected) return;
          this.managers = this.managers.filter((x) => x.id !== id);
          if (this.hostId === id && this.managers.length) this.hostId = this.managers[0].id;
          this.broadcastLobby();
        }, FAST ? 50 : 25000);
      } else {
        clearTimeout(this.lobbyDrop[id]);
      }
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
    if (!connected && this.phase === 'spin') this.autoSpinIfOnlyGhosts();
    const inAuction = this.phase === 'auction';
    if (!connected && inAuction && !m.sacked && !this.hostPaused) {
      if (!this.paused) { this.paused = true; this.pausedAt = Date.now(); }
      this.io.emit('paused', { manager: m.name, maxMs: TIMINGS.DISCONNECT_PAUSE_MS });
      clearTimeout(this.timers.lot);
      clearTimeout(this.timers.pause);
      this.timers.pause = setTimeout(() => this.resume(), TIMINGS.DISCONNECT_PAUSE_MS);
    }
    if (connected && this.paused && !this.hostPaused) this.resume();
  }

  hostPause(managerId) {
    if (managerId !== this.hostId) return { error: 'Host only' };
    if (this.phase !== 'auction') return { error: 'No auction running' };
    if (this.paused) return { error: 'Already paused' };
    this.paused = true;
    this.pausedAt = Date.now();
    this.hostPaused = true;
    clearTimeout(this.timers.lot);
    clearTimeout(this.timers.pause); // a pending auto-resume can never undo a host pause
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
    if (!this.paused || this.hostPaused) return; // only hostResume can undo a host pause
    clearTimeout(this.timers.pause);
    const pausedFor = Date.now() - this.pausedAt;
    this.paused = false;
    if (this.auction && this.auction.current) {
      this.auction.deadline = Math.max(this.auction.deadline + pausedFor, Date.now() + 3000); // resume grace
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
      auction: this.phase === 'auction' && this.auction && this.auction.current ? {
        window: this.auction.window,
        player: { name: this.auction.current.name, pos: this.auction.current.pos, hint: this.hintFor(this.auction.current), legend: !!this.auction.current.legend, wonderkid: !!this.auction.current.wonderkid },
        highBid: this.auction.highBid,
        highBidder: this.auction.highBidder ? (this.managers.find((x) => x.id === this.auction.highBidder) || {}).name : null,
        deadline: this.auction.deadline,
        index: this.auction.index, total: this.auction.queue.length,
        revealLeft: Math.max(0, (this.auction.revealUntil || 0) - Date.now()),
      } : null,
      table: this.season ? this.table() : null,
      winter: this.phase === 'winter' ? this.winterPayload() : null,
      reveal: this.reveal && this.reveal.waiting ? this.reveal.last : null,
      spin: (this.phase === 'spin' && this.wheels && this.wheels[forId]) ? {
        segments: this.wheels[forId].segments.map((s) => ({ name: s.name, pos: s.pos, rating: s.rating, kind: s.kind })),
        spun: this.pendingSpins ? !this.pendingSpins.has(forId) : true,
      } : null,
      pick: (this.phase === 'setup' && this.pendingStarters) ? (() => {
        const me = this.managers.find((x) => x.id === forId);
        if (!me || me.sacked) return null;
        return {
          half: this.startersHalf,
          locked: !this.pendingStarters.has(forId),
          squad: me.squad.map((p) => ({ name: p.name, pos: p.pos, injured: p.name === me.injured, rtg: p.rating, wonderkid: !!p.wonderkid, grew: p.grew || 0 })),
        };
      })() : null,
      serverV: 'v3.4',
      paused: this.paused,
    };
  }
}

module.exports = { Game, FORMATIONS, TIMINGS, mid };
