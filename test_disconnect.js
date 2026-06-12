// Test: disconnect mid-auction pauses; rejoin resumes with snapshot.
const { io } = require('socket.io-client');
const URL = 'http://localhost:3152';
let failures = [];
const assert = (c, m) => { if (!c) { failures.push(m); console.log('ASSERT FAIL:', m); } };
const connected = (s) => s.connected ? Promise.resolve() : new Promise((r) => s.once('connect', r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const a = io(URL, { transports: ['websocket'] });
  const b = io(URL, { transports: ['websocket'] });
  await connected(a); await connected(b);
  let code, aId, bId;
  await new Promise((res) => a.emit('createLobby', { name: 'A', club: 'A FC' }, (r) => { code = r.code; aId = r.managerId; res(); }));
  await new Promise((res) => b.emit('joinLobby', { code, name: 'B', club: 'B FC' }, (r) => { bId = r.managerId; res(); }));
  let pausedSeen = false, resumedSeen = false, lotSeen = false;
  a.on('paused', () => { pausedSeen = true; });
  a.on('resumed', () => { resumedSeen = true; });
  a.on('lot', () => { lotSeen = true; });
  a.emit('ready', { ready: true }); b.emit('ready', { ready: true });
  await sleep(100);
  a.emit('startGame');
  await sleep(400); // auction underway
  assert(lotSeen, 'no lot before disconnect');
  b.disconnect();
  await sleep(200);
  assert(pausedSeen, 'pause not broadcast on disconnect');
  // rejoin with stored managerId
  const b2 = io(URL, { transports: ['websocket'] });
  await connected(b2);
  let snap = null;
  await new Promise((res) => b2.emit('joinLobby', { code, name: 'B', club: '' }, (r) => { snap = r; res(); }));
  assert(snap && snap.ok, 'rejoin failed: ' + (snap && snap.error));
  assert(snap.snapshot && snap.snapshot.phase, 'no snapshot');
  assert(snap.snapshot.auction && snap.snapshot.auction.player, 'snapshot missing live auction state');
  await sleep(300);
  assert(resumedSeen, 'resume not broadcast after rejoin');
  // new socket can bid
  let bidOk = null;
  await new Promise((res) => b2.emit('bid', { amount: 1 }, (r) => { bidOk = r; res(); }));
  assert(bidOk && (bidOk.ok || /Min bid|highest/.test(bidOk.error || '')), 'rejoined socket cannot bid: ' + JSON.stringify(bidOk));
  console.log(failures.length ? 'FAILURES: ' + failures.length : 'DISCONNECT/REJOIN TEST PASSED');
  process.exit(failures.length ? 1 : 0);
})();
