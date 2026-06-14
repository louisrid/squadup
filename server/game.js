// Game state machine. One Game instance per lobby. Server-authoritative.
// Pool selection uses FC26 ratings ONLY. Engine ratings are used solely for
// match simulation, form scores, injuries and awards — never for what appears at auction.
const E = require('./engine');
const ALL_PLAYERS = require('./data/players.json');


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
  { name: 'Andrés Iniesta', pos: 'MID', fc26: 95, rating: 94, legend: true },
  { name: 'Xavi', pos: 'MID', fc26: 95, rating: 93, legend: true },
  { name: 'Ronaldinho', pos: 'MID', fc26: 95, rating: 95, legend: true },
  { name: 'Thierry Henry', pos: 'ATT', fc26: 95, rating: 94, legend: true },
  { name: 'Andrea Pirlo', pos: 'MID', fc26: 95, rating: 93, legend: true },
  { name: 'Kaká', pos: 'ATT', fc26: 95, rating: 93, legend: true },
];

const AI_CLUB_NAMES = [
  'Red Fellas', 'Bluebridge FC', 'Ninja FC', 'Eastvale Rovers',
  'Westvale City', 'Donkey United', 'Northfield Athletic', 'Hanting Town',
  'Desperado FC', 'Andover FC',
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
  AUCTION_BID_ADD_MS: FAST ? 60 : 4000,
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
    const posQuota = { GK: n, DEF: 2 * n, MID: 2 * n, ATT: 2 * n }; // 1 GK + 2 of each outfield line, per manager
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
      const cand = E.shuffle(ALL_PLAYERS.filter((p) => p.rating >= t.lo && p.rating <= t.hi && !p.hero && !p.autofillOnly && !inPool.has(p.name)));
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
        let repl = E.shuffle(ALL_PLAYERS.filter((p) => p.pos === pos && p.rating >= tier.lo && p.rating <= tier.hi && !p.hero && !p.autofillOnly && !inPool.has(p.name)))[0];
        if (!repl) repl = E.shuffle(ALL_PLAYERS.filter((p) => p.pos === pos && p.rating >= 80 && !p.hero && !p.autofillOnly && !inPool.has(p.name)))[0];
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
    // wonderkids on offer: 1 (35%), 2 (60%), 3 (5%) — a little more than before, never a flood
    const wkRoll = Math.random();
    const wantWk = wkRoll < 0.35 ? 1 : wkRoll < 0.95 ? 2 : 3;
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
    // rare hero card in the opening auction (~18% of windows, one slot)
    if (Math.random() < 0.18) {
      const hero = E.shuffle(ALL_PLAYERS.filter((p) => p.hero && !inPool.has(p.name) && !this.owned(p.name)))[0];
      if (hero) {
        const victim = E.shuffle(pool.filter((p) => !p.wonderkid && p.pos === hero.pos)) [0] || E.shuffle(pool.filter((p) => !p.wonderkid && p.pos !== 'GK'))[0];
        if (victim) { inPool.delete(victim.name); inPool.add(hero.name); pool[pool.indexOf(victim)] = hero; }
      }
    }
    // first lot is always a gentle opener (no wonderkid, ≤85). then DISTRIBUTE the strong
    // players across the whole auction so lot 2 isn't instantly a 90+ headliner.
    pool.sort((a, b) => a.rating - b.rating);
    const opener = pool.filter((p) => !p.wonderkid && p.rating <= 85)[0] || pool[0];
    let remaining = E.shuffle(pool.filter((p) => p !== opener));
    const elites = remaining.filter((p) => p.rating >= 88);     // the headliners
    const others = E.shuffle(remaining.filter((p) => p.rating < 88));
    // spread elites roughly evenly through the "others" timeline, never two in a row,
    // and never in the first two slots after the opener (so the start stays calm).
    const seq = [...others];
    const ne = elites.length;
    if (ne) {
      const span = seq.length;
      for (let k = 0; k < ne; k++) {
        // target positions spaced across the back ~75% of the list
        let idx = Math.round(span * (0.25 + 0.7 * ((k + 0.5) / ne)));
        idx = Math.min(seq.length, Math.max(2, idx)) + k; // shift for earlier inserts
        // avoid back-to-back elites
        while (idx > 0 && seq[idx - 1] && seq[idx - 1].rating >= 88) idx++;
        seq.splice(Math.min(idx, seq.length), 0, elites[k]);
      }
    }
    return [opener, ...seq];
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
        m.squad.push({ ...a.current, seasonMod: 0, freshSigning: a.window === 'winter' });
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
      player: { name: a.current.name, pos: a.current.pos, hint: this.hintFor(a.current), wonderkid: !!a.current.wonderkid, legend: !!a.current.legend, hero: !!a.current.hero },
      revealMs: this.sp(TIMINGS.LOT_REVEAL_MS),
    });
    setTimeout(() => {
      if (!a.current) return;
      a.deadline = Date.now() + this.sp(TIMINGS.AUCTION_START_MS);
      a.revealUntil = 0;
      this.io.emit('lot', {
        index: a.index, total: a.queue.length,
        player: { name: a.current.name, pos: a.current.pos, hint: this.hintFor(a.current), wonderkid: !!a.current.wonderkid, legend: !!a.current.legend, hero: !!a.current.hero },
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

  ensureKeepers() {
    // managers who didn't buy enough get FREE low-rated players.
    // goal: a valid keeper, at least one of each outfield line, ONE spare DEF/MID/ATT each,
    // and enough bodies to field a five with bench cover. freebies are 70-81, mostly the
    // dedicated 70-77 squad fillers, with a tiny chance of a wonderkid.
    for (const m of this.activeManagers()) {
      const has = (pos) => m.squad.filter((p) => p.pos === pos).length;
      const grant = (pos) => {
        let p = null;
        if (Math.random() < 0.05) {
          p = E.shuffle(ALL_PLAYERS.filter((x) => x.wonderkid && (!pos || x.pos === pos) && !this.owned(x.name)))[0];
        }
        // ONLY the dedicated AI-generated filler pool — never real players from autofill
        if (!p) p = E.shuffle(ALL_PLAYERS.filter((x) => x.autofillOnly && (!pos || x.pos === pos) && !this.owned(x.name)))[0];
        if (!p) p = E.shuffle(ALL_PLAYERS.filter((x) => x.autofillOnly && x.pos !== 'GK' && !this.owned(x.name)))[0];
        if (!p && pos === 'GK') p = { name: 'Youth Keeper', pos: 'GK', fc26: 70, rating: 70 };
        if (!p) p = { name: 'Youth Prospect', pos: pos && pos !== 'GK' ? pos : 'MID', fc26: 70, rating: 70 };
        m.squad.push({ ...p, seasonMod: 0 });
        m.signings.push({ player: p.name, price: 0, window: 'freebie' });
        this.io.emit('autoFill', { manager: m.name, player: p.name, pos: p.pos });
      };
      // 1) exactly one keeper
      if (has('GK') === 0) grant('GK');
      // 2) at least one of each outfield line
      for (const pos of ['DEF', 'MID', 'ATT']) if (has(pos) === 0) grant(pos);
      // 3) one SPARE in each outfield line (so a red-carded/injured starter always has a like-for-like sub)
      let guard = 0;
      for (const pos of ['DEF', 'MID', 'ATT']) {
        if (has(pos) < 2 && guard++ < 12) grant(pos);
      }
      // 4) top up to at least 6 with outfield bodies so any formation is coverable
      guard = 0;
      const outfield = ['DEF', 'MID', 'ATT'];
      while (m.squad.length < 6 && guard++ < 20) grant(outfield[guard % 3]);
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
    // shape -> tactic: more attackers = Attacking, more defenders = Defensive, else Balanced
    if (c.ATT > c.DEF) return 'ATT';
    if (c.DEF > c.ATT) return 'DEF';
    return 'BAL';
  }
  static formationName(starters) {
    const c = { DEF: 0, MID: 0, ATT: 0 };
    for (const p of starters) if (c[p.pos] !== undefined) c[p.pos]++;
    if (c.ATT > c.DEF) return { key: 'ATT', name: 'Attacking', shape: '1-1-2', blurb: ['Score more goals', 'Concede a little more'] };
    if (c.DEF > c.ATT) return { key: 'DEF', name: 'Defensive', shape: '2-1-1', blurb: ['Concede fewer goals', 'Score a little less'] };
    return { key: 'BAL', name: 'Balanced', shape: '1-2-1', blurb: ['Strong midfield control', 'Steady at both ends'] };
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
    const healthy = m.squad.filter((p) => p.name !== m.injured);
    // only forbid the injured player if the squad can field 5 without him
    if (healthy.length >= 5 && players.some((p) => p.name === m.injured)) return { error: 'Injured player selected' };
    if (players.filter((p) => p.pos === 'GK').length !== 1) return { error: 'Exactly one keeper' };
    const fit = healthy.length >= 5 ? healthy : m.squad;
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
    for (const m of this.activeManagers()) for (const p of m.squad) p.seasonMod = E.rollSeasonEvent(p.rating);
    const n = this.managers.length;
    const humanTeams = this.managers.map((m, i) => ({ type: 'human', mIdx: i, name: m.club }));
    const strengths = this.managers.map((m) => E.teamStrength(m.starters, m.formation));
    const avg = strengths.reduce((s, t) => s + (t.attack + t.midfield + t.defence) / 3, 0) / n;
    // each season: Eastvale Rovers is always a notch above; ALSO pick one other (non-Donkey) AI to be a bit strong.
    const eligibleSecond = AI_CLUB_NAMES.filter((nm) => nm !== 'Eastvale Rovers' && nm !== 'Donkey United');
    const secondStrong = eligibleSecond[Math.floor(Math.random() * eligibleSecond.length)];
    const ais = E.aiStrengths(n, avg, 12 - n).map((s, i) => {
      const t = { type: 'ai', name: AI_CLUB_NAMES[i], attack: s.attack - 0.8, midfield: s.midfield - 0.8, defence: s.defence - 0.8 };
      if (t.name === 'Eastvale Rovers') { t.attack += 1.4; t.midfield += 1.4; t.defence += 1.4; t.elite = true; t.eliteBonus = 1.4; }
      else if (t.name === secondStrong) { t.attack += 0.9; t.midfield += 0.9; t.defence += 0.9; t.elite = true; t.eliteBonus = 0.9; }
      return t;
    });
    this.season = {
      teams: [...humanTeams, ...ais],
      fixtures: E.buildFixtures(12),
      pts: Array(12).fill(0), gf: Array(12).fill(0), ga: Array(12).fill(0),
      w: Array(12).fill(0), d: Array(12).fill(0), l: Array(12).fill(0),
      playerStats: {},
      results: [],
      ptsHist: this.managers.map(() => []),   // cumulative points per matchday, per team index
      gfHist: this.managers.map(() => []),    // cumulative goals-for per matchday
      allPtsHist: [...humanTeams, ...ais].map(() => []), // every team's cumulative points, for the league race
      teamCount: 0,
    };
    this.suspensions = {}; // fresh each season — never carry red-card state across games
    this.rusty = {};
    this.phase = 'firstHalf';
    this.io.emit('phase', { phase: 'firstHalf' });
    this.revealHalf(0, 11, () => this.startWinter()); // spin parked — respins are back
  }

  lineupFor(t, md) {
    if (t.type === 'ai') return null;
    const m = this.managers[t.mIdx];
    this.suspensions = this.suspensions || {};
    const out = [];
    for (const p of m.starters) {
      if (this.suspensions[p.name] !== md) { out.push(p); continue; }
      const sub = m.squad
        .filter((q) => !m.starters.includes(q) && q.name !== m.injured && q.pos === p.pos)
        .sort((a, b) => (b.rating + b.seasonMod) - (a.rating + a.seasonMod))[0]
        || m.squad.filter((q) => !m.starters.includes(q) && q.name !== m.injured && q.pos !== 'GK' && p.pos !== 'GK')
        .sort((a, b) => (b.rating + b.seasonMod) - (a.rating + a.seasonMod))[0];
      if (sub) out.push(sub);
    }
    return out;
  }

  teamStrengthNow(t, md) {
    if (t.type === 'ai') return { attack: t.attack + (t.comeback || 0), midfield: (t.midfield != null ? t.midfield : t.attack) + (t.comeback || 0), defence: t.defence + (t.comeback || 0) };
    const m = this.managers[t.mIdx];
    this.suspensions = this.suspensions || {};
    this.rusty = this.rusty || {};
    const eligible = this.lineupFor(t, md) || [];
    const s = E.teamStrength(eligible.length ? eligible : m.starters, m.formation);
    // a player coming back from a red is rusty: small, slightly noticeable team penalty that one game
    const rustyBack = eligible.some((p) => this.rusty[p.name] === md);
    const pen = rustyBack ? 1.2 : 0;
    return { attack: s.attack + (t.comeback || 0) - pen, midfield: s.midfield + (t.comeback || 0) - pen, defence: s.defence + (t.comeback || 0) - pen };
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
        if (Math.random() < 0.12) {
          const big = 7 + Math.floor(Math.random() * 3), small = Math.floor(Math.random() * 2);
          r = donkey === 'A' ? { ...r, goalsA: big, goalsB: small } : { ...r, goalsA: small, goalsB: big };
        } else {
          const win = 1 + Math.floor(Math.random() * 3), lose = Math.floor(Math.random() * 2);
          r = donkey === 'A' ? { ...r, goalsA: Math.min(r.goalsA, lose), goalsB: Math.max(r.goalsB, win) }
                             : { ...r, goalsB: Math.min(r.goalsB, lose), goalsA: Math.max(r.goalsA, win) };
        }
      }
      let detail = null;
      const sA = TA.type === 'human' ? this.lineupFor(TA, md) : null;
      const sB = TB.type === 'human' ? this.lineupFor(TB, md) : null;
      if (sA || sB) {
        // a player can only be sent off if the manager has a same-position bench replacement available
        const replaceable = (T, lineup) => {
          if (!lineup) return null;
          const m = this.managers[T.mIdx];
          return lineup
            .filter((p) => p.pos !== 'GK' && m.squad.some((q) => q.pos === p.pos && !lineup.includes(q) && q.name !== m.injured))
            .map((p) => p.name);
        };
        const redPool = { A: replaceable(TA, sA), B: replaceable(TB, sB) };
        detail = E.buildCommentary(r, sA || [{ name: TA.name, pos: 'ATT', rating: 80 }], sB || [{ name: TB.name, pos: 'ATT', rating: 80 }], { redA: !!sA, redB: !!sB, redPool });
        this.suspensions = this.suspensions || {};
        for (const red of detail.reds || []) {
          if ((red.side === 'A' && sA) || (red.side === 'B' && sB)) { this.suspensions[red.name] = md + 1; this.rusty = this.rusty || {}; this.rusty[red.name] = md + 2; const rs = (this.season.playerStats[red.name] ||= { goals: 0, assists: 0 }); rs.reds = (rs.reds || 0) + 1; }
        }
        for (const s of detail.scorersA) if (sA && !s.og) this.bumpStat(s.name, s.assist);
        for (const s of detail.scorersB) if (sB && !s.og) this.bumpStat(s.name, s.assist);
        // per-player appearances + rolling rating (lineup actually fielded)
        for (const [side, lineup] of [['A', sA], ['B', sB]]) {
          if (!lineup) continue;
          for (const p of lineup) {
            const ps = (this.season.playerStats[p.name] ||= { goals: 0, assists: 0 });
            ps.apps = (ps.apps || 0) + 1;
            ps.rtgSum = (ps.rtgSum || 0) + (p.rating + (p.seasonMod || 0));
          }
        }
      }
      this.season.gf[a] += r.goalsA; this.season.ga[a] += r.goalsB;
      this.season.gf[b] += r.goalsB; this.season.ga[b] += r.goalsA;
      if (r.goalsA > r.goalsB) { this.season.pts[a] += 3; this.season.w[a]++; this.season.l[b]++; }
      else if (r.goalsA < r.goalsB) { this.season.pts[b] += 3; this.season.w[b]++; this.season.l[a]++; }
      else { this.season.pts[a]++; this.season.pts[b]++; this.season.d[a]++; this.season.d[b]++; }
      out.push({ md, a, b, ...r, detail, suspended,
        homeForm: TA.type === 'human' ? Game.formationName(this.managers[TA.mIdx].starters).key : null,
        awayForm: TB.type === 'human' ? Game.formationName(this.managers[TB.mIdx].starters).key : null,
        humans: (sA ? 1 : 0) + (sB ? 1 : 0) });
    }
    // snapshot cumulative standings for every human team this matchday
    this.managers.forEach((m, mi) => {
      const ti = this.season.teams.findIndex((t) => t.type === 'human' && t.mIdx === mi);
      if (ti >= 0) { this.season.ptsHist[mi].push(this.season.pts[ti]); this.season.gfHist[mi].push(this.season.gf[ti]); }
    });
    // snapshot EVERY team's cumulative points for the league-race animation
    this.season.allPtsHist = this.season.allPtsHist || this.season.teams.map(() => []);
    this.season.teams.forEach((t, i) => this.season.allPtsHist[i].push(this.season.pts[i]));
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
      homeForm: item.homeForm || null,
      awayForm: item.awayForm || null,
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
      .map((p) => { const boosted = Math.max(92, Math.min(94, p.rating + 6 + Math.floor(Math.random() * 6)));
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
      breakdowns: this.buildBreakdowns(),
      race: this.raceHistory(),
      review: this.activeManagers().map((m) => ({
        id: m.id,
        manager: m.name,
        club: m.club,
        respins: m.respins != null ? m.respins : 3,
        locked: this.pendingStarters && this.startersHalf === 'second' ? !this.pendingStarters.has(m.id) : false,
        units: this.unitScores(m),
        starters: (m.starters || []).map((p) => p.name),
        tips: this.assistantTips(m),
        validFormations: this.validFormations(m),
        players: m.squad.map((p) => ({
          name: p.name, pos: p.pos, legend: !!p.legend, wonderkid: !!p.wonderkid, hero: !!p.hero, rtg: p.rating,
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
    for (const m of this.activeManagers()) m.respins = 3;
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
      if (Math.random() < 0.03) {
        const ranked = [...m.squad].sort((a, b) => (b.rating + b.seasonMod) - (a.rating + a.seasonMod));
        const victim = ranked.find((p) => p.pos !== 'GK' && !p.wonderkid && !p.legend);
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
        this.season.teams[ti] = { type: 'ai', name: this.season.teams[ti].name, attack: s.attack, midfield: s.midfield, defence: s.defence };
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

  respin(managerId, playerName) {
    if (this.phase !== 'winter') return { error: 'Respins only at the winter break' };
    const m = this.managers.find((x) => x.id === managerId);
    if (!m || m.sacked) return { error: 'Not in the game' };
    if (!m.respins || m.respins <= 0) return { error: 'No respins left' };
    const old = m.squad.find((p) => p.name === playerName);
    if (!old) return { error: 'Not your player' };
    const lo = Math.max(84, old.rating), hi = Math.min(93, old.rating + 6); // never a downgrade
    const allowHero = Math.random() < 0.12; // heroes only on a rare lucky respin
    const eligible = (p) => p.pos === old.pos && !p.wonderkid && p.rating >= lo && p.rating <= hi
      && !this.owned(p.name) && !LEGENDS.some((l) => l.name === p.name) && (allowHero || !p.hero);
    const cand = E.shuffle(ALL_PLAYERS.filter(eligible))[0]
      || E.shuffle(ALL_PLAYERS.filter((p) => p.pos === old.pos && !p.hero && p.rating >= lo && p.rating <= hi && !this.owned(p.name) && !p.wonderkid && !LEGENDS.some((l) => l.name === p.name)))[0]
      || E.shuffle(ALL_PLAYERS.filter((p) => p.pos === old.pos && !p.hero && !this.owned(p.name)))[0];
    if (!cand) return { error: 'Nobody available' };
    m.squad[m.squad.indexOf(old)] = { ...cand, seasonMod: 0 };
    if (m.injured === old.name) m.injured = null;
    m.respins -= 1;
    m.signings.push({ player: cand.name, price: 0, window: 'respin' });
    this.io.emit('respun', { manager: m.name, out: old.name, in: { name: cand.name, pos: cand.pos, rating: cand.rating }, left: m.respins });
    return { ok: true, in: { name: cand.name, pos: cand.pos, rating: cand.rating }, out: old.name, left: m.respins };
  }

  hostStartWinterAuction(managerId) {
    if (managerId !== this.hostId) return { error: 'Host only' };
    if (this.phase !== 'winter' || this.auction && this.auction.window === 'winter' && this.auction.current !== undefined && this.phase === 'auction') return { error: 'Not now' };
    this.startWinterAuction();
    return { ok: true };
  }

  startWinterAuction() {
    this.broadcastBudgets();
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
    // per manager: 1 GK, 1 DEF, 1 MID, 1 ATT, plus 1 extra that is a 50/50 MID or ATT
    const want = { GK: n, DEF: n, MID: n, ATT: n };
    for (let k = 0; k < n; k++) want[Math.random() < 0.5 ? 'MID' : 'ATT']++;
    const total = want.GK + want.DEF + want.MID + want.ATT;
    // 60% of windows feature 1 legend, 40% feature 2 — outfield legends replace an outfield slot
    const legendCount = Math.random() < 0.6 ? 1 : 2;
    const legends = E.shuffle(LEGENDS.filter((l) => !this.owned(l.name) && l.pos !== 'GK')).slice(0, legendCount).map((l) => ({ ...l, rating: 96, pot: 96 }));
    const ok = (p, pos, lo) => p.pos === pos && p.rating >= lo && !p.wonderkid && !p.hero && !p.autofillOnly && !this.owned(p.name) && !LEGENDS.some((l) => l.name === p.name);
    const fresh = (lo) => ({
      GK: E.shuffle(ALL_PLAYERS.filter((p) => ok(p, 'GK', lo))),
      DEF: E.shuffle(ALL_PLAYERS.filter((p) => ok(p, 'DEF', lo))),
      MID: E.shuffle(ALL_PLAYERS.filter((p) => ok(p, 'MID', lo))),
      ATT: E.shuffle(ALL_PLAYERS.filter((p) => ok(p, 'ATT', lo))),
    });
    const byPos = fresh(86);
    const backup = fresh(82);
    const rest = [];
    const take = (pos, cnt) => {
      for (let k = 0; k < cnt; k++) {
        const p = byPos[pos].shift() || backup[pos].find((x) => !rest.includes(x));
        if (p && !rest.includes(p)) rest.push(p);
      }
    };
    // each legend consumes one outfield slot of its position so totals stay on-spec
    const legByPos = { DEF: 0, MID: 0, ATT: 0 };
    for (const l of legends) if (legByPos[l.pos] != null) legByPos[l.pos]++;
    take('GK', want.GK);
    for (const pos of ['DEF', 'MID', 'ATT']) take(pos, Math.max(0, want[pos] - legByPos[pos]));
    // optionally upgrade one slot to a hero (mutually exclusive: keeper OR outfield, at most one)
    if (Math.random() < 0.30) {
      const hk = E.shuffle([
        ...LEGENDS.filter((l) => l.pos === 'GK' && !this.owned(l.name)).map((l) => ({ ...l, rating: 95, pot: 95 })),
        ...ALL_PLAYERS.filter((p) => p.pos === 'GK' && p.hero && !this.owned(p.name)),
      ])[0];
      if (hk) { const i = rest.findIndex((x) => x.pos === 'GK'); if (i >= 0) rest[i] = hk; else rest.push(hk); }
    } else if (Math.random() < 0.30) {
      const hero = E.shuffle(ALL_PLAYERS.filter((p) => p.hero && p.pos !== 'GK' && !this.owned(p.name) && !rest.some((x) => x.name === p.name)))[0];
      if (hero) { const i = rest.findIndex((x) => x.pos === hero.pos); if (i >= 0) rest[i] = hero; else rest.push(hero); }
    }
    // place legends: never lots 1-3, never back-to-back
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
    // re-roll hidden season form for the second half (winter growth already baked into rating).
    for (const m of this.activeManagers()) for (const p of m.squad) {
      let mod = E.rollSeasonEvent(p.rating);
      if (p.freshSigning && mod < 0) mod = 0; // a brand-new signing arrives fresh, never in an instant slump
      p.seasonMod = mod;
      delete p.freshSigning;
    }
    // re-anchor AI clubs to the post-winter human level so scorelines stay sane
    const live = this.activeManagers();
    if (live.length) {
      const strengths = live.map((m) => E.teamStrength(m.starters, m.formation));
      const avg = strengths.reduce((s, t) => s + (t.attack + t.midfield + t.defence) / 3, 0) / live.length;
      for (const t of this.season.teams) {
        if (t.type === 'ai' && !t.wasHuman) {
          const base = avg + E.gauss() * 1.1 - 3.2; // post-winter squads are stronger; keep AI a clear step below
          const eb = t.eliteBonus || 0;
          t.attack = base + E.gauss() * 0.6 + eb;
          t.midfield = base + E.gauss() * 0.6 + eb;
          t.defence = base + E.gauss() * 0.6 + eb;
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
      breakdowns: this.buildBreakdowns(),
      race: this.raceHistory(),
    });
  }

  seasonFormOf(p) {
    // prefer the form already shown on the winter report so numbers never disagree on screen
    if (p.winterForm != null) return p.winterForm;
    const st = this.season.playerStats[p.name] || {};
    const apps = st.apps || 0;
    const eff = p.rating + (p.seasonMod || 0);
    const perGame = apps ? (st.goals || 0) + (st.assists || 0) * 0.6 : 0;
    let form = 5.0 + (eff - 83) * 0.12 + perGame * 1.4 + (p.seasonMod || 0) * 0.18 - (st.reds || 0) * 0.4;
    return Math.round(E.clamp(form, 1, 10) * 10) / 10;
  }

  buildBreakdowns() {
    return this.managers.map((m, mi) => {
      const ti = this.season.teams.findIndex((t) => t.type === 'human' && t.mIdx === mi);
      const priceOf = {};
      for (const s of m.signings) if (priceOf[s.player] == null || s.price > 0) priceOf[s.player] = s.price;
      return {
        manager: m.name, club: m.club, sacked: !!m.sacked,
        finalPos: ti >= 0 ? (this.table().findIndex((r) => r.manager === m.name) + 1) : null,
        ptsHist: this.season.ptsHist[mi] || [],
        gfHist: this.season.gfHist[mi] || [],
        squad: m.squad.map((p) => {
          const st = this.season.playerStats[p.name] || {};
          return {
            name: p.name, pos: p.pos, rating: p.rating + (p.seasonMod || 0),
            legend: !!p.legend, wonderkid: !!p.wonderkid, hero: !!p.hero,
            goals: st.goals || 0, assists: st.assists || 0, reds: st.reds || 0,
            apps: st.apps || 0,
            avgRtg: st.apps ? +(st.rtgSum / st.apps).toFixed(1) : (p.rating + (p.seasonMod || 0)),
            form: this.seasonFormOf(p),
            price: priceOf[p.name] != null ? priceOf[p.name] : null,
          };
        }).sort((a, b) => b.goals - a.goals || b.assists - a.assists || b.rating - a.rating),
      };
    });
  }

  // points-by-matchday for every team (humans + AI) — for the animated league race
  raceHistory() {
    const hist = this.season.allPtsHist || [];
    return this.season.teams.map((t, i) => ({
      name: t.name,
      manager: t.type === 'human' ? this.managers[t.mIdx].name : null,
      human: t.type === 'human',
      pts: hist[i] || [],
    }));
  }

  // ---------- connection handling ----------
  broadcastBudgets() {
    this.io.emit('budgets', this.activeManagers().map((m) => ({
      name: m.name, budget: m.budget,
      squadCount: m.squad.length,
      done: !!m.sacked,
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
      awaitingNext: (this.phase === 'auction' && this.auction && !this.auction.current && this.auction.index < this.auction.queue.length) ? {
        index: this.auction.index, total: this.auction.queue.length,
        hostName: (this.managers.find((x) => x.id === this.hostId) || {}).name || 'Host',
      } : null,
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
      serverV: 'v7.1',
      paused: this.paused,
    };
  }
}

module.exports = { Game, FORMATIONS, TIMINGS, mid };
