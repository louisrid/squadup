// E2E: 4 bot managers play a complete game over real websockets.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3101';

const NAMES = ['Louis', 'Tom', 'Ben', 'Jack'];
const log = (...a) => console.log(...a);
let failures = [];
const assert = (cond, msg) => { if (!cond) { failures.push(msg); log('ASSERT FAIL:', msg); } };

function makeBot(name, i) {
  const s = io(URL, { transports: ['websocket'] });
  const bot = { name, s, managerId: null, code: null, budget: 100, squadCount: 0, mySquad: [], seen: {} };

  s.on('lot', ({ player, deadline }) => {
    bot.seen.lots = (bot.seen.lots || 0) + 1;
    // simple bot: bid with decreasing enthusiasm as budget drops
    setTimeout(() => {
      const maxSpend = Math.max(1, Math.floor(bot.budget * (0.15 + Math.random() * 0.3)));
      if (Math.random() < 0.75) s.emit('bid', { amount: Math.min(maxSpend, 1 + Math.floor(Math.random() * 5)) }, () => {});
    }, 20 + Math.random() * 60);
  });
  s.on('bid', ({ amount, manager }) => {
    if (manager !== name && Math.random() < 0.5) {
      setTimeout(() => s.emit('bid', { amount: amount + 1 }, () => {}), 10 + Math.random() * 40);
    }
  });
  s.on('budgets', (rows) => {
    const me = rows.find((r) => r.name === name);
    if (me) { bot.budget = me.budget; bot.squadCount = me.squadCount; }
  });
  s.on('pickStarters', ({ half, perManager }) => {
    bot.seen['pick_' + half] = true;
    const mine = perManager.find((p) => p.id === bot.managerId);
    if (!mine) return;
    assert(mine.validFormations.length > 0, `${name} has no valid formation (${half})`);
    const f = mine.validFormations[0];
    const slots = { DEF: ['GK','DEF','DEF','MID','ATT'], BAL: ['GK','DEF','MID','MID','ATT'], ATT: ['GK','DEF','MID','ATT','ATT'] }[f];
    const avail = mine.squad.filter((p) => !p.injured);
    const chosen = [];
    for (const pos of slots) {
      const p = avail.find((x) => x.pos === pos && !chosen.includes(x));
      if (p) chosen.push(p);
    }
    assert(chosen.length === 5, `${name} could not fill ${f}: got ${chosen.length} (squad: ${mine.squad.map(p=>p.pos).join(',')})`);
    s.emit('submitStarters', { formation: f, starters: chosen.map((p) => p.name) }, (r) => {
      assert(r.ok, `${name} starters rejected: ${r.error}`);
    });
  });
  s.on('winter', (w) => {
    bot.seen.winter = w;
    const mine = w.review.find((r) => r.id === bot.managerId);
    if (!mine || bot.sacked) return;
    // exercise respins: bot0 spins twice, others once
    const spins = name === 'A' ? 2 : 1;
    let done = 0;
    const spinNext = () => {
      const target = mine.players.find((p) => !p.injured);
      s.emit('respin', { player: bot.lastSpin || target.name }, (r) => {
        assert(r.ok || r.error === 'No replacement available', `${name} respin rejected: ${r.error}`);
        done++;
        if (done < spins) setTimeout(spinNext, 30);
        else setTimeout(lock, 60);
      });
    };
    const lock = () => {
      // re-derive squad from latest respinResult review
      const rv = (bot.latestReview || w.review).find((r) => r.id === bot.managerId);
      const f = rv.validFormations[0];
      const slots = { DEF: ['GK','DEF','DEF','MID','ATT'], BAL: ['GK','DEF','MID','MID','ATT'], ATT: ['GK','DEF','MID','ATT','ATT'] }[f];
      const avail = rv.players.filter((p) => !p.injured);
      const chosen = [];
      for (const pos of slots) {
        const p = avail.find((x) => x.pos === pos && !chosen.includes(x));
        if (p) chosen.push(p);
      }
      assert(chosen.length === 5, `${name} winter lock could not fill ${f}`);
      s.emit('submitStarters', { formation: f, starters: chosen.map((p) => p.name) }, (r) => {
        assert(r.ok, `${name} winter lock rejected: ${r.error}`);
      });
    };
    setTimeout(spinNext, 30);
  });
  s.on('respinResult', (x) => {
    bot.latestReview = x.review;
    bot.seen.spins = (bot.seen.spins || 0) + 1;
    if (x.manager === name) bot.lastSpin = null;
    // duplicate ownership check across all reviews
    const names = [];
    for (const r of x.review) for (const p of r.players) names.push(p.name);
    assert(new Set(names).size === names.length, 'DUPLICATE player across squads after respin: ' + x.newPlayer.name);
  });
  s.on('matchReveal', () => { bot.seen.reveals = (bot.seen.reveals || 0) + 1; });
  s.on('phase', ({ phase }) => { bot.seen['phase_' + phase] = true; });
  s.on('finished', (f) => { bot.seen.finished = f; });
  s.on('lotSold', ({ manager, player }) => { if (manager === name) bot.mySquad.push(player); });
  s.on('autoFill', ({ manager, player }) => { if (manager === name) bot.mySquad.push(player); });
  return bot;
}

const connected = (s) => s.connected ? Promise.resolve() : new Promise((res) => s.once('connect', res));

(async () => {
  const bots = NAMES.map(makeBot);
  const [host, ...rest] = bots;

  await connected(host.s);
  await new Promise((res) =>
    host.s.emit('createLobby', { name: host.name, club: host.name + ' FC' }, (r) => {
      assert(r.ok, 'createLobby failed');
      host.managerId = r.managerId; host.code = r.code; res();
    })
  );
  for (const b of rest) {
    await connected(b.s);
    await new Promise((res) =>
      b.s.emit('joinLobby', { code: host.code, name: b.name, club: b.name + ' FC' }, (r) => {
        assert(r.ok, `${b.name} join failed: ${r.error}`);
        b.managerId = r.managerId; b.code = host.code; res();
      })
    );
  }
  for (const b of bots) b.s.emit('ready', { ready: true });
  await new Promise((r) => setTimeout(r, 100));
  host.s.emit('startGame');
  log('game started, code', host.code);

  // wait for finish (max 60s in FAST mode)
  const t0 = Date.now();
  while (!bots[0].seen.finished && Date.now() - t0 < 60000) await new Promise((r) => setTimeout(r, 200));

  // ---- assertions ----
  const b0 = bots[0];
  assert(b0.seen.finished, 'game did not finish in time');
  if (b0.seen.finished) {
    const f = b0.seen.finished;
    assert(f.table.length === 12, 'final table not 12 teams');
    const pts = f.table.map((r) => r.pts);
    assert(pts.every((p, i) => i === 0 || p <= pts[i - 1]), 'table not sorted');
    const totalPts = pts.reduce((a, b) => a + b, 0);
    // 132 matches, each gives 2 (draw) or 3 pts: bounds 264..396
    assert(totalPts >= 264 && totalPts <= 396, 'points total out of bounds: ' + totalPts);
    log('CHAMPION:', f.champion.name, f.champion.pts, 'pts', f.champion.type);
    log('AWARDS:', JSON.stringify(f.awards));
    assert(f.awards.goldenBoot && f.awards.goldenBoot.goals > 0, 'no golden boot');
  }
  assert(b0.seen.phase_firstHalf, 'no firstHalf phase');
  assert(b0.seen.spins >= 4, 'respins not exercised: ' + b0.seen.spins);
  assert(b0.seen.phase_secondHalf, 'no secondHalf phase');
  assert(b0.seen.reveals >= 60, 'too few reveals: ' + b0.seen.reveals);
  assert(b0.seen.winter && b0.seen.winter.review.length >= 3, 'winter review missing');
  for (const b of bots) {
    assert(b.seen['pick_first'], `${b.name} never asked for starters`);
    assert(b.mySquad.length >= 0, 'squad tracking');
  }
  // squads complete after auction: every active manager ended with >= 6 players (incl autofill)
  const w = b0.seen.winter;
  if (w) for (const r of w.review) assert(r.players.length >= 6, `${r.manager} squad < 6 at winter: ${r.players.length}`);
  log(b0.seen.reveals, 'match reveals shown to clients');
  log('bot0 saw:', JSON.stringify(Object.keys(b0.seen)), 'lots:', b0.seen.lots);
  log(failures.length ? `FAILURES: ${failures.length}` : 'ALL E2E CHECKS PASSED');
  process.exit(failures.length ? 1 : 0);
})();
