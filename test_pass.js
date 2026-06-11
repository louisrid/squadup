// give-up: B bids, A passes -> lot settles instantly to B
const { io } = require('socket.io-client');
const URL='http://localhost:3100';
const connected=(s)=>s.connected?Promise.resolve():new Promise(r=>s.once('connect',r));
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
let fail=[]; const assert=(c,m)=>{if(!c){fail.push(m);console.log('FAIL:',m);}};
(async()=>{
  const a=io(URL,{transports:['websocket']}), b=io(URL,{transports:['websocket']});
  await connected(a); await connected(b);
  let code, sold=null, tSettle=0, tBid=0;
  a.on('lotSold',(x)=>{ if(!sold){sold=x; tSettle=Date.now();} });
  await new Promise(res=>a.emit('createLobby',{name:'A',club:'A FC'},(r)=>{code=r.code;res();}));
  await new Promise(res=>b.emit('joinLobby',{code,name:'B',club:'B FC'},(r)=>res()));
  a.emit('ready',{ready:true}); b.emit('ready',{ready:true});
  await sleep(80); a.emit('startGame');
  await new Promise(res=>{ a.once('lot',()=>res()); });
  await sleep(30);
  await new Promise(res=>b.emit('bid',{amount:2},()=>res()));
  tBid=Date.now();
  await new Promise(res=>a.emit('passLot',(r)=>{ assert(r.ok,'pass rejected: '+(r&&r.error)); res(); }));
  await sleep(150);
  assert(sold,'lot did not settle after lone bidder remained');
  if(sold) assert(sold.manager==='B' && sold.price===2, 'wrong settlement: '+JSON.stringify(sold));
  if(sold) assert(tSettle-tBid<500,'settlement not instant: '+(tSettle-tBid)+'ms');
  console.log(fail.length?'FAILURES '+fail.length:'GIVE-UP TEST PASSED');
  process.exit(fail.length?1:0);
})();
