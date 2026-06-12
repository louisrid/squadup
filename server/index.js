const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Game, mid } = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, '..', 'public'), {
  setHeaders: (res, p) => { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache, must-revalidate'); },
}));
app.get('/health', (_q, res) => res.json({ ok: true }));

const games = new Map(); // code -> Game

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
  socket.on('createLobby', ({ name, club, hints }, cb) => {
    let code = mid();
    while (games.has(code)) code = mid();
    const game = new Game(code, roomEmitter(code));
    game.showHints = !!hints;
    games.set(code, game);
    socket.join(code);
    const r = game.addManager(socket.id, name, club);
    if (r.error) return cb(r);
    joined = { code, managerId: socket.id };
    cb({ ok: true, code, managerId: socket.id });
  });

  socket.on('joinLobby', ({ code, name, club }, cb) => {
    code = (code || '').toUpperCase().trim();
    const game = games.get(code);
    if (!game) return cb({ error: 'Lobby not found' });
    // same name + seat free (disconnected or mid-game) -> reclaim that manager
    const existing = game.managers.find((m) => m.name === name);
    const canReclaim = existing && (!existing.connected || game.phase !== 'lobby');
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
      joined = { code, managerId: socket.id };
      game.setConnected(socket.id, true);
      return cb({ ok: true, code, managerId: socket.id, snapshot: game.snapshot(socket.id) });
    }
    if (existing) return cb({ error: 'Name taken in this lobby' });
    socket.join(code);
    const r = game.addManager(socket.id, name, club);
    if (r.error) return cb(r);
    joined = { code, managerId: socket.id };
    cb({ ok: true, code, managerId: socket.id });
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

  socket.on('startGame', () => {
    const g = current();
    if (g && g.hostId === joined.managerId) g.startGame();
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
    cb && cb(g ? g.hostSetSpeed(joined.managerId, !!fast) : { error: 'No game' });
  });
  socket.on('passLot', (cb) => {
    const g = current();
    cb && cb(g ? g.passLot(joined.managerId) : { error: 'No game' });
  });
  socket.on('hostNextMatch', (cb) => {
    const g = current();
    cb && cb(g ? g.hostAdvanceReveal(joined.managerId) : { error: 'No game' });
  });
  socket.on('hostNext', (cb) => {
    const g = current();
    cb && cb(g ? g.hostNextLot(joined.managerId) : { error: 'No game' });
  });
  socket.on('hostPause', (cb) => {
    const g = current();
    cb && cb(g ? g.hostPause(joined.managerId) : { error: 'No game' });
  });
  socket.on('hostResume', (cb) => {
    const g = current();
    cb && cb(g ? g.hostResume(joined.managerId) : { error: 'No game' });
  });

  socket.on('suggestXI', (cb) => {
    const g = current();
    cb && cb(g ? g.suggestXI(joined.managerId) : { error: 'No game' });
  });
  socket.on('respin', ({ player }, cb) => {
    const g = current();
    cb && cb(g ? g.respin(joined.managerId, player) : { error: 'No game' });
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
    return joined ? games.get(joined.code) : null;
  }
});

// cleanup finished/abandoned games hourly
setInterval(() => {
  for (const [code, g] of games) {
    const empty = g.managers.every((m) => !m.connected);
    if (g.phase === 'finished' || (g.phase === 'lobby' && empty)) games.delete(code);
  }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Football Auction Manager on :${PORT}`));
