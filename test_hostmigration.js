// host disconnects mid-auction -> host migrates, game continues to completion
const { io } = require('socket.io-client');
const URL = 'http://localhost:3121';
const connected = (s) => s.connected ? Promise.resolve() : new Promise((r) => s.once('connect', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fail = [];
const assert = (c, m) => { if (!c) { fail.push(m); console.log('FAIL:', m); } };
(async () => {
  const mk = (name) => {
    const s = io(URL, { transports: ['websocket'] });
    const bot = { name, s, seen: {} };
    s.on('lot', () => { setTimeout(() => s.emit('bid', { amount: 1 + Math.floor(Math.random() * 3) }, () => {}), 30); });
    s.on('bid', (b) => { if (b.manager !== name && Math.random() < 0.4) setTimeout(() => s.emit('bid', { amount: b.amount + 1 }, () => {}), 20); });
    s.on('hostChanged', (x) => { bot.seen.hostChanged = x; });
    s.on('pickStarters', (p) => {
      const mine = p.perManager.find((x) => x.id === bot.managerId); if (!mine) return;
      const f = 'FREE';
      const avail = mine.squad.filter((p) => !p.injured);
      const gk = avail.find((x) => x.pos === 'GK');
      const chosen = [gk, ...avail.filter((x) => x.pos !== 'GK').slice(0, 4)].filter(Boolean);
      s.emit('submitStarters', { formation: f, starters: chosen.map((x) => x.name) }, () => {});
    });
    s.on('winter', (w) => setTimeout(() => {
      const mine = w.review.find((r) => r.id === bot.managerId);
      if (!mine) return;
      const f = 'FREE';
      const avail = mine.players.filter((p) => !p.injured);
      const gk = avail.find((x) => x.pos === 'GK');
      const chosen = [gk, ...avail.filter((x) => x.pos !== 'GK').slice(0, 4)].filter(Boolean);
      s.emit('submitStarters', { formation: f, starters: chosen.map((x) => x.name) }, () => {});
    }, 30));
    s.on('finished', (f) => { bot.seen.finished = f; });
    return bot;
  };
  const a = mk('A'), b = mk('B'), c = mk('C');
  await connected(a.s); await connected(b.s); await connected(c.s);
  let code;
  await new Promise((res) => a.s.emit('createLobby', { name: 'A', club: 'A FC' }, (r) => { code = r.code; a.managerId = r.managerId; res(); }));
  await new Promise((res) => b.s.emit('joinLobby', { code, name: 'B', club: 'B FC' }, (r) => { b.managerId = r.managerId; res(); }));
  await new Promise((res) => c.s.emit('joinLobby', { code, name: 'C', club: 'C FC' }, (r) => { c.managerId = r.managerId; res(); }));
  [a, b, c].forEach((x) => x.s.emit('ready', { ready: true }));
  await sleep(80);
  a.s.emit('startGame');
  await sleep(600); // auction underway (FAST)
  a.s.disconnect(); // HOST GONE
  await sleep(400);
  assert(b.seen.hostChanged || c.seen.hostChanged, 'no hostChanged broadcast');
  const t0 = Date.now();
  while (!b.seen.finished && Date.now() - t0 < 60000) await sleep(200);
  assert(b.seen.finished, 'game did not complete after host left');
  console.log(fail.length ? 'FAILURES ' + fail.length : 'HOST MIGRATION TEST PASSED');
  process.exit(fail.length ? 1 : 0);
})();
