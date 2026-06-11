// Verify JS port matches Python calibration targets
const E = require('./server/engine');

// 1) pairwise win rates
function pairwise(diff, n=20000){
  let w=0,d=0,l=0;
  for(let i=0;i<n;i++){
    const A={attack:85+diff,defence:85+diff}, B={attack:85,defence:85};
    const r=E.playMatch(A,B);
    if(r.goalsA>r.goalsB)w++; else if(r.goalsA===r.goalsB)d++; else l++;
  }
  return [w/n,d/n,l/n].map(x=>+(x*100).toFixed(1));
}
console.log('+3:',pairwise(3),'(target ~59/21/20)');
console.log('+6:',pairwise(6),'(target ~79/13/8)');
console.log(' 0:',pairwise(0),'(target ~37/25/37)');

// 2) scorelines
let g=0; const c={};
for(let i=0;i<20000;i++){
  const A={attack:85+E.gauss(0,3),defence:85+E.gauss(0,3)};
  const B={attack:85+E.gauss(0,3),defence:85+E.gauss(0,3)};
  const r=E.playMatch(A,B); g+=r.goalsA+r.goalsB;
  const k=r.goalsA+'-'+r.goalsB; c[k]=(c[k]||0)+1;
}
console.log('avg goals:',(g/20000).toFixed(2),'(target ~3.1)');
console.log('top scorelines:',Object.entries(c).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([k,v])=>k+':'+(100*v/20000).toFixed(1)+'%').join(' '));

// 3) fixtures sanity
const fx=E.buildFixtures(12);
console.log('matchdays:',fx.length,'matches/md:',fx[0].length);
const counts={};
for(const md of fx) for(const [a,b] of md){counts[a]=(counts[a]||0)+1;counts[b]=(counts[b]||0)+1;}
const vals=[...new Set(Object.values(counts))];
console.log('each team plays:',vals,'(target [22])');
// no team twice in same matchday
let dup=false;
for(const md of fx){const s=new Set();for(const [a,b] of md){if(s.has(a)||s.has(b))dup=true;s.add(a);s.add(b);}}
console.log('team twice in one matchday:',dup,'(target false)');
// every pair meets exactly twice
const pair={};
for(const md of fx)for(const [a,b] of md){const k=[Math.min(a,b),Math.max(a,b)].join('-');pair[k]=(pair[k]||0)+1;}
console.log('pair meeting counts:',[...new Set(Object.values(pair))],'(target [2])');

// 4) goalscorers + commentary smoke test
const sq=[{name:'GK Guy',pos:'GK',rating:85},{name:'Def Guy',pos:'DEF',rating:85},{name:'Mid Guy',pos:'MID',rating:85},{name:'Att Guy',pos:'ATT',rating:88},{name:'Att Two',pos:'ATT',rating:84}];
const res=E.buildCommentary({goalsA:2,goalsB:1},sq,sq);
console.log('commentary sample:',res.events.map(e=>e.text).join(' | '));
const tally={};
for(let i=0;i<30000;i++){const s=E.attributeGoals(1,sq)[0];tally[s.name]=(tally[s.name]||0)+1;}
console.log('scorer split over 30k goals:',Object.entries(tally).map(([k,v])=>k+':'+(100*v/30000).toFixed(0)+'%').join(' '));
