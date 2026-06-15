const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Game, mid } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingTimeout: 20000, pingInterval: 10000 });

app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate'); },
}));
app.get('/health', (_q, res) => res.json({ ok: true }));

const games = new Map();
process.on('uncaughtException', (e) => console.error('UNCAUGHT (survived):', e));
process.on('unhandledRejection', (e) => console.error('UNHANDLED (survived):', e)); // code -> Game

function roomEmitter(code) {
  return { emit: (ev, data) => io.to(code).emit(ev, data) };
}

io.on('connection', (socket) => {
  let joined = null; // { code, managerId }

  socket.on('findMyGames', ({ name }, cb) => {
    const out = [];
    for (const [code, g] of games) {
      if (g.phase === 'finished') continue;
      if (g.managers.some((m) => m.name === name)) out.push({ code, phase: g.phase });
    }
    cb && cb({ games: out });
  });
  socket.on('createLobby', ({ name, club, hints, standings }, cb) => {
    let code = mid();
    while (games.has(code)) code = mid();
    const game = new Game(code, roomEmitter(code));
    game.showHints = !!hints;
    game.showStandings = standings === undefined ? true : !!standings;
    games.set(code, game);
    socket.join(code);
    const r = game.addManager(socket.id, name, club);
    if (r.error) return cb(r);
    joined = { code, managerId: socket.id, uid: r.uid };
    cb({ ok: true, code, managerId: socket.id, uid: r.uid });
  });

  socket.on('joinLobby', ({ code, name, club, uid }, cb) => {
    code = (code || '').toUpperCase().trim();
    const game = games.get(code);
    if (!game) return cb({ error: 'Lobby not found — if it existed a minute ago, the server restarted (deploy/idle). Create a fresh one.' });
    // reclaim by stable uid first (survives reconnects with no name race), then fall back to name.
    let existing = uid ? game.managers.find((m) => m.uid === uid) : null;
    if (!existing) existing = game.managers.find((m) => m.name === name && !m.isBot);
    const canReclaim = existing && (existing.uid === uid || !existing.connected || game.phase !== 'lobby');
    if (canReclaim) {
      const oldId = existing.id;
      existing.id = socket.id;
      if (game.hostId === oldId) game.hostId = socket.id;
      if (game.auction && game.auction.highBidder === oldId) game.auction.highBidder = socket.id;
      if (game.pendingStarters && game.pendingStarters.has(oldId)) {
        game.pendingStarters.delete(oldId);
        game.pendingStarters.add(socket.id);
      }
      const oldSock = io.sockets.sockets.get(oldId);
      if (oldSock && oldSock.id !== socket.id) oldSock.disconnect(true);
      socket.join(code);
      joined = { code, managerId: socket.id, uid: existing.uid };
      game.setConnected(socket.id, true);
      return cb({ ok: true, code, managerId: socket.id, uid: existing.uid, snapshot: game.snapshot(socket.id) });
    }
    if (existing) return cb({ error: 'Name taken in this lobby' });
    socket.join(code);
    const r = game.addManager(socket.id, name, club);
    if (r.error) return cb(r);
    joined = { code, managerId: socket.id, uid: r.uid };
    cb({ ok: true, code, managerId: socket.id, uid: r.uid });
  });

  // rejoin after disconnect: client stores managerId + code
  socket.on('rejoin', ({ code, managerId }, cb) => {
    const game = games.get((code || '').toUpperCase());
    if (!game) return cb({ error: 'Game not found' });
    const m = game.managers.find((x) => x.id === managerId);
    if (!m) return cb({ error: 'Manager not found' });
    // re-bind manager to new socket id
    const oldId = m.id;
    m.id = socket.id;
    if (game.hostId === oldId) game.hostId = socket.id;
    if (game.auction && game.auction.highBidder === oldId) game.auction.highBidder = socket.id;
    if (game.pendingStarters && game.pendingStarters.has(oldId)) {
      game.pendingStarters.delete(oldId);
      game.pendingStarters.add(socket.id);
    }
    socket.join(game.code);
    joined = { code: game.code, managerId: socket.id };
    game.setConnected(socket.id, true);
    cb({ ok: true, managerId: socket.id, snapshot: game.snapshot(socket.id) });
  });

  socket.on('ready', ({ ready }) => {
    const g = current();
    if (g) g.setReady(joined.managerId, !!ready);
  });

  socket.on('startGame', (cb) => {
    const g = current();
    if (!g) return cb && cb({ error: 'No game' });
    if (!isHost(g)) return cb && cb({ error: 'Only the host can start' });
    const r = g.startGame();
    cb && cb(r || { ok: true });
  });

  socket.on('endGame', (cb) => {
    const g = current();
    if (!g) { joined = null; return cb && cb({ ok: true }); }
    if (!isHost(g)) return cb && cb({ error: 'Only the host can end the game' });
    games.delete(g.code);
    io.to(g.code).emit('lobbyClosed', { reason: 'Host ended the game' });
    joined = null;
    cb && cb({ ok: true });
  });

  socket.on('leaveLobby', (cb) => {
    const g = current();
    if (!g) { joined = null; return cb && cb({ ok: true }); }
    if (g.phase === 'lobby') {
      const wasHost = isHost(g);
      g.managers = g.managers.filter((m) => m.id !== socket.id && m.id !== joined.managerId);
      socket.leave(g.code);
      const humansLeft = g.managers.filter((m) => !m.isBot).length;
      if (wasHost || humansLeft === 0) {
        games.delete(g.code);
        io.to(g.code).emit('lobbyClosed', { reason: wasHost ? 'Host left' : 'Lobby empty' });
      } else {
        g.broadcastLobby();
      }
    }
    joined = null;
    cb && cb({ ok: true });
  });

  socket.on('addBot', ({ difficulty }, cb) => {
    const g = current();
    if (!g) return cb && cb({ error: 'No game' });
    if (!isHost(g)) return cb && cb({ error: 'Only the host can add bots' });
    cb && cb(g.addBot(difficulty));
  });

  socket.on('setBotsDiff', ({ difficulty }, cb) => {
    const g = current();
    if (!g) return cb && cb({ error: 'No game' });
    if (!isHost(g)) return cb && cb({ error: 'Only the host can change difficulty' });
    cb && cb(g.setBotsDiff(difficulty));
  });

  socket.on('bid', ({ amount }, cb) => {
    const g = current();
    if (!g) return cb && cb({ error: 'No game' });
    const r = g.bid(joined.managerId, amount);
    cb && cb(r);
  });

  socket.on('submitStarters', ({ formation, starters }, cb) => {
    const g = current();
    if (!g) return cb && cb({ error: 'No game' });
    cb && cb(g.submitStarters(joined.managerId, formation, starters));
  });

  socket.on('hostSpeed', ({ fast }, cb) => {
    const g = current();
    if(!g) return cb && cb({error:'No game'}); cb && cb(g.hostSetSpeed(isHost(g)?g.hostId:joined.managerId, !!fast));
  });
  socket.on('passLot', (cb) => {
    const g = current();
    cb && cb(g ? g.passLot(joined.managerId) : { error: 'No game' });
  });
  socket.on('hostNextMatch', (cb) => {
    const g = current();
    if(!g) return cb && cb({error:'No game'}); cb && cb(g.hostAdvanceReveal(isHost(g)?g.hostId:joined.managerId));
  });
  socket.on('hostNext', (cb) => {
    const g = current();
    if(!g) return cb && cb({error:'No game'}); cb && cb(g.hostNextLot(isHost(g)?g.hostId:joined.managerId));
  });
  socket.on('hostPause', (cb) => {
    const g = current();
    if (!g) return cb && cb({ error: 'No game' });
    cb && cb(g.hostPause(isHost(g) ? g.hostId : joined.managerId));
  });
  socket.on('hostResume', (cb) => {
    const g = current();
    if (!g) return cb && cb({ error: 'No game' });
    cb && cb(g.hostResume(isHost(g) ? g.hostId : joined.managerId));
  });

  socket.on('suggestXI', (cb) => {
    const g = current();
    cb && cb(g ? g.suggestXI(joined.managerId) : { error: 'No game' });
  });
  socket.on('respin', (d, cb) => {
    const g = current();
    cb && cb(g ? g.respin(joined.managerId, d && d.name) : { error: 'No game' });
  });
  socket.on('forceSpins', (cb) => {
    const g = current();
    if(!g) return cb && cb({error:'No game'}); cb && cb(g.hostForceSpins(isHost(g)?g.hostId:joined.managerId));
  });
  socket.on('doSpin', (cb) => {
    const g = current();
    cb && cb(g ? g.doSpin(joined.managerId) : { error: 'No game' });
  });
  socket.on('winterReady', ({ ready }, cb) => {
    const g = current();
    cb && cb(g ? g.setWinterReady(joined.managerId, !!ready) : { error: 'No game' });
  });
  socket.on('getStandings', (cb) => {
    const g = current();
    if (!g) return cb && cb({ error: 'No game' });
    cb && cb({ ok: true, showStandings: !!g.showStandings, table: g.season ? g.table() : null, stats: g.season ? g.seasonStats() : null });
  });
  socket.on('startWinterAuction', (cb) => {
    const g = current();
    if(!g) return cb && cb({error:'No game'}); cb && cb(g.hostStartWinterAuction(isHost(g)?g.hostId:joined.managerId));
  });

  socket.on('getSnapshot', (cb) => {
    const g = current();
    cb && cb(g ? g.snapshot(joined.managerId) : { error: 'No game' });
  });

  socket.on('disconnect', () => {
    const g = current();
    if (g) g.setConnected(joined.managerId, false);
  });

  function current() {
    if (joined && games.get(joined.code)) return games.get(joined.code);
    // closure lost (fresh socket after reconnect): re-resolve from the rooms this socket is in
    for (const code of socket.rooms) {
      const g = games.get(code);
      if (g) {
        const m = g.managers.find((x) => x.id === socket.id);
        if (m) { joined = { code, managerId: socket.id, uid: m.uid }; return g; }
      }
    }
    return null;
  }
  // robust host check: matches by current socket, the stored join id, OR the stable uid
  function isHost(g) {
    if (!g) return false;
    if (g.hostId === socket.id) return true;
    if (joined && g.hostId === joined.managerId) return true;
    if (joined && joined.uid) { const h = g.managers.find((m) => m.id === g.hostId); if (h && h.uid === joined.uid) return true; }
    return false;
  }
});

// cleanup finished/abandoned games — a lobby must be empty for 30+ minutes before deletion,
// so a host with a briefly backgrounded phone never loses the room
setInterval(() => {
  const now = Date.now();
  for (const [code, g] of games) {
    const empty = g.managers.every((m) => !m.connected);
    if (!empty) g.lastSeen = now;
    if (g.phase === 'finished') { games.delete(code); continue; }
    if (g.phase === 'lobby' && empty && now - (g.lastSeen || now - 1) > 30 * 60 * 1000) games.delete(code);
    if (g.lastSeen === undefined) g.lastSeen = now;
  }
}, 5 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Football Auction Manager on :${PORT}`));
