// server.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

// Oyun ayarları
const ROUND_DURATION = 300; // sn
const GRID = 20;
const W = 800 / GRID; // 40
const H = 600 / GRID; // 30

// Tick ve yayın optimizasyonu
const TICK_MS = 80;           // oyun adımı (12.5 Hz)
const BROADCAST_EVERY = 2;    // her 2 tick'te bir state yayınla (~6.25 Hz)

// Express + Socket.IO
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  // polling gecikmesini ve takılmaları azaltmak için doğrudan websocket
  transports: ['websocket'],
  pingTimeout: 20000,
  pingInterval: 25000,
  perMessageDeflate: { threshold: 1024 },
});

app.use(express.static(path.join(__dirname)));
app.get('/', (req,res)=>res.sendFile(path.join(__dirname, 'client.html')));

// Highscores
const HS_FILE = path.join(__dirname, 'highscores.json');
function loadHS(){ try { return JSON.parse(fs.readFileSync(HS_FILE,'utf8')||'[]'); } catch { return []; } }
function saveHS(arr){ try { fs.writeFileSync(HS_FILE, JSON.stringify(arr.slice(0,100),null,2)); } catch {} }
app.get('/highscores', (req,res)=> res.json(loadHS().slice(0,100)) );

// Eşleşme
const waitingQueue = []; // {socketId, nick, ip, isBot:false, botTimer?}
const nickToSocket = new Map();
const games = new Map(); // roomId -> game

function canUseNick(nick, ip){
  for (const [n, info] of nickToSocket.entries()){
    if (n===nick && info.ip!==ip) return false; // aynı IP tekrar kullanabilir
  }
  return true;
}

io.on('connection', (socket)=>{
  const ip = socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim() || socket.handshake.address;
  socket.data.nick = null;
  socket.data.roomId = null;

  socket.on('set_nick', (nick)=>{
    nick = String(nick||'').trim();
    if (!nick) { socket.emit('nick_error','Kullanıcı adı boş olamaz!'); return; }
    if (nick.length>15){ socket.emit('nick_error','Kullanıcı adı en fazla 15 karakter olabilir.'); return; }
    if (!canUseNick(nick, ip)){ socket.emit('nick_error','Bu kullanıcı adı kullanılıyor.'); return; }
    socket.data.nick = nick;
    nickToSocket.set(nick, { socketId: socket.id, ip });
    enqueueForMatch(socket, nick, ip);
  });

  socket.on('countdown_done', ()=>{
    const g = findGameBySocket(socket.id);
    if (!g) return;
    g.readyFlags[socket.id] = true;
    maybeStartGameLoop(g);
  });

  socket.on('input', (payload)=>{
    const g = findGameBySocket(socket.id);
    if (!g || !g.loopStarted) return;
    const { dir } = payload || {};
    if (!dir) return;
    if (socket.id === g.p1Id) setDir(g.state.p1, dir);
    else if (socket.id === g.p2Id) setDir(g.state.p2, dir);
  });

  socket.on('rematch', ()=>{
    const g = findGameBySocket(socket.id);
    if (!g) return;
    g.rematchReady[socket.id] = true;
    tryStartRematch(g);
  });

  socket.on('find_new', ()=>{
    leaveCurrentGame(socket);
    if (socket.data.nick) enqueueForMatch(socket, socket.data.nick, ip);
  });

  socket.on('disconnect', ()=>{
    // kuyruktaysa çıkar
    const i = waitingQueue.findIndex(w=>w.socketId===socket.id);
    if (i>=0){
      const w = waitingQueue.splice(i,1)[0];
      if (w.botTimer) clearTimeout(w.botTimer);
    }
    // oyundaysa bitir
    const g = findGameBySocket(socket.id);
    if (g) endGame(g, socket.id===g.p1Id ? 'p2' : 'p1', 'disconnect');
    // nick temizle
    if (socket.data.nick){
      const info = nickToSocket.get(socket.data.nick);
      if (info && info.socketId===socket.id) nickToSocket.delete(socket.data.nick);
    }
  });
});

function findGameBySocket(sid){
  for (const g of games.values()){
    if (g.p1Id===sid || g.p2Id===sid) return g;
  }
  return null;
}

function enqueueForMatch(socket, nick, ip){
  // bekleyen biri var mı?
  const idx = waitingQueue.findIndex(w=>w.socketId!==socket.id);
  if (idx>=0){
    const w = waitingQueue.splice(idx,1)[0];
    if (w.botTimer) clearTimeout(w.botTimer);
    createGame({ p1: w, p2: {socketId: socket.id, nick, ip, isBot:false} });
    return;
  }
  // yoksa sıraya ekle ve 5sn sonra botla başlat
  const entry = { socketId: socket.id, nick, ip, isBot:false, botTimer:null };
  waitingQueue.push(entry);
  entry.botTimer = setTimeout(()=>{
    const i = waitingQueue.findIndex(w=>w.socketId===socket.id);
    if (i>=0){
      waitingQueue.splice(i,1);
      createGame({ p1: entry, p2: { socketId: 'BOT_'+Date.now(), nick:'BOT', ip:'-', isBot:true } });
    }
  }, 5000);
}

function leaveCurrentGame(socket){
  const g = findGameBySocket(socket.id);
  if (!g) return;
  endGame(g, socket.id===g.p1Id ? 'p2' : 'p1', 'leave_for_new');
}

function createGame({p1, p2}){
  const roomId = 'R'+Math.random().toString(36).slice(2,9);
  const s1 = io.sockets.sockets.get(p1.socketId);
  const botP2 = !!p2.isBot;
  let s2 = null;
  if (s1){ s1.join(roomId); s1.data.roomId=roomId; }
  if (!botP2){
    s2 = io.sockets.sockets.get(p2.socketId);
    if (s2){ s2.join(roomId); s2.data.roomId=roomId; }
  }

  const state = makeInitialState(p1.nick, p2.nick, botP2);
  const g = {
    roomId,
    p1Id: s1 ? s1.id : null,
    p2Id: botP2 ? null : (s2 ? s2.id : null),
    p1Nick: p1.nick,
    p2Nick: p2.nick,
    bot: botP2,
    loop: null,
    loopStarted: false,
    left: ROUND_DURATION,
    leftTimer: null,
    state,
    readyFlags: {},
    rematchReady: {},
    tickCounter: 0
  };
  games.set(roomId, g);

  // maç başlangıcı: rol bilgisini bireysel gönder (client kontrol mantığı sadeleşir)
  if (s1) s1.emit('match_start', { duration: ROUND_DURATION, role: 'p1' });
  if (s2) s2.emit('match_start', { duration: ROUND_DURATION, role: 'p2' });

  // bot hazıra al
  if (g.p1Id) g.readyFlags[g.p1Id] = false;
  if (!g.p2Id) g.readyFlags['BOT'] = true; else g.readyFlags[g.p2Id] = false;

  // emniyet: 4 sn sonra yine de başlat
  setTimeout(()=> maybeStartGameLoop(g, /*force*/true), 4000);
}

function makeInitialState(n1, n2, bot){
  return {
    n1, n2,
    p1: snakeAt(5, 10, 1, 0),
    p2: snakeAt(34, 19, -1, 0),
    food: randEmptyCell(null, null),
    sfood: null,
    nextSpecialAt: pickNextSpecial(10,15,20),
    eatenCount: 0,
    over: false,
    winner: null
  };
}
function snakeAt(x,y,dx,dy){
  const body=[]; for(let i=0;i<5;i++) body.push({x:x - i*dx, y:y - i*dy});
  return { body, dir:{x:dx,y:dy}, pending:0, score:0 };
}
function randEmptyCell(p1,p2){
  const taken=new Set();
  const add=(x,y)=>taken.add(x+','+y);
  if (p1) for (const c of p1.body) add(c.x,c.y);
  if (p2) for (const c of p2.body) add(c.x,c.y);
  while(true){
    const x=(Math.random()*W|0), y=(Math.random()*H|0);
    if (!taken.has(x+','+y)) return {x,y};
  }
}
function pickNextSpecial(...opts){ return opts[Math.floor(Math.random()*opts.length)]; }

function maybeStartGameLoop(g, force=false){
  if (g.loopStarted) return;
  const allReady = force || Object.values(g.readyFlags).every(v=>v===true);
  if (!allReady) return;

  g.loopStarted = true;
  g.tickCounter = 0;

  g.loop = setInterval(()=> tick(g), TICK_MS);

  g.left = ROUND_DURATION;
  g.leftTimer = setInterval(()=>{
    if (g.state.over){ clearInterval(g.leftTimer); return; }
    g.left--;
    if (g.left<=0){
      if (g.state.p1.score > g.state.p2.score) endGame(g,'p1','timeup');
      else if (g.state.p2.score > g.state.p1.score) endGame(g,'p2','timeup');
      else endGame(g,'draw','timeup');
    }
  }, 1000);
}

function tick(g){
  const S = g.state;

  // Bot
  if (g.bot){
    const d = botThink(S);
    if (d) setDir(S.p2, d);
  }

  stepSnake(S.p1);
  stepSnake(S.p2);

  const p1Dead = isDead(S.p1, S.p2);
  const p2Dead = isDead(S.p2, S.p1);

  handleFood(S, 'p1');
  handleFood(S, 'p2');

  if (p1Dead || p2Dead){
    if (p1Dead && p2Dead) endGame(g,'draw','crash');
    else if (p1Dead) endGame(g,'p2','crash');
    else endGame(g,'p1','crash');
    return;
  }

  // Yayın: her 2 tick'te bir (volatile -> paket kaçırılırsa sorun değil, bir sonraki gelir)
  g.tickCounter++;
  if (g.tickCounter % BROADCAST_EVERY === 0){
    io.to(g.roomId).volatile.emit('state', {
      n1: S.n1, n2: S.n2,
      p1: { body:S.p1.body, score:S.p1.score },
      p2: { body:S.p2.body, score:S.p2.score },
      food: S.food, sfood: S.sfood,
      left: g.left,
      over: S.over, winner: S.winner
    });
  }
}

function setDir(s, dir){
  const nx = Math.sign(dir.x), ny = Math.sign(dir.y);
  if (s.dir.x + nx === 0 && s.dir.y + ny === 0) return; // tersine dönme yok
  s.dir = {x:nx, y:ny};
}
function stepSnake(s){
  const h=s.body[0];
  const nx=h.x + s.dir.x, ny=h.y + s.dir.y;
  s.body.unshift({x:nx,y:ny});
  if (s.pending>0) s.pending--; else s.body.pop();
}
function isDead(self, other){
  const h=self.body[0];
  if (h.x<0 || h.y<0 || h.x>=W || h.y>=H) return true;
  for (let i=1;i<self.body.length;i++) if (self.body[i].x===h.x && self.body[i].y===h.y) return true;
  for (let i=0;i<other.body.length;i++) if (other.body[i].x===h.x && other.body[i].y===h.y) return true;
  return false;
}
function handleFood(S, who){
  const me = who==='p1'?S.p1:S.p2;
  if (S.food && me.body[0].x===S.food.x && me.body[0].y===S.food.y){
    me.score += 1; me.pending += 1;
    S.eatenCount++;
    if (S.eatenCount >= S.nextSpecialAt && !S.sfood){
      S.sfood = randEmptyCell(S.p1, S.p2);
      S.eatenCount = 0;
      S.nextSpecialAt = pickNextSpecial(10,15,20);
    }
    S.food = randEmptyCell(S.p1, S.p2);
  }
  if (S.sfood && me.body[0].x===S.sfood.x && me.body[0].y===S.sfood.y){
    me.score += 10; me.pending += 10;
    S.sfood = null;
  }
}

function botThink(S){
  const h=S.p2.body[0];
  const t = S.sfood || S.food;
  const cand = [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];
  let best=null, bestDist=Infinity;
  for (const d of cand){
    const nx=h.x+d.x, ny=h.y+d.y;
    if (isPointDead({x:nx,y:ny}, S.p2, S.p1)) continue;
    const dist=Math.abs(nx - t.x) + Math.abs(ny - t.y);
    if (dist<bestDist){ bestDist=dist; best=d; }
  }
  return best || S.p2.dir;
}
function isPointDead(h, self, other){
  if (h.x<0 || h.y<0 || h.x>=W || h.y>=H) return true;
  for (const c of self.body) if (c.x===h.x && c.y===h.y) return true;
  for (const c of other.body) if (c.x===h.x && c.y===h.y) return true;
  return false;
}

function endGame(g, winner, reason){
  if (!g || g.state.over) return;
  g.state.over = true;
  g.state.winner = winner;

  if (g.loop){ clearInterval(g.loop); g.loop=null; }
  if (g.leftTimer){ clearInterval(g.leftTimer); g.leftTimer=null; }

  // Highscore yazımı (bot liste dışı)
  const hs = loadHS();
  const pushIfEligible = (nick,score)=>{ if(nick && nick!=='BOT') hs.push({nick,score,ts:Date.now()}); };
  if (winner==='p1') pushIfEligible(g.p1Nick, g.state.p1.score);
  else if (winner==='p2') pushIfEligible(g.p2Nick, g.state.p2.score);
  else if (winner==='draw'){ pushIfEligible(g.p1Nick, g.state.p1.score); pushIfEligible(g.p2Nick, g.state.p2.score); }
  hs.sort((a,b)=> b.score - a.score || a.ts - b.ts);
  saveHS(hs);

  io.to(g.roomId).emit('state', {
    n1: g.state.n1, n2: g.state.n2,
    p1: { body:g.state.p1.body, score:g.state.p1.score },
    p2: { body:g.state.p2.body, score:g.state.p2.score },
    food: g.state.food, sfood: g.state.sfood,
    left: g.left,
    over: true, winner
  });
}

function tryStartRematch(g){
  const need=[]; if (g.p1Id) need.push(g.p1Id); if (g.p2Id) need.push(g.p2Id);
  const ok = need.every(id=>g.rematchReady[id]);
  if (!ok){
    const rdy = { p1: !!g.rematchReady[g.p1Id], p2: g.p2Id ? !!g.rematchReady[g.p2Id] : true };
    io.to(g.roomId).emit('rematch_wait', rdy);
    return;
  }
  g.state = makeInitialState(g.p1Nick, g.p2Nick, g.bot);
  g.left = ROUND_DURATION;
  g.readyFlags = {};
  g.rematchReady = {};
  if (g.p1Id) g.readyFlags[g.p1Id]=false;
  if (!g.p2Id) g.readyFlags['BOT']=true; else g.readyFlags[g.p2Id]=false;

  // rol bilgisini tekrar gönder
  const s1 = io.sockets.sockets.get(g.p1Id);
  const s2 = io.sockets.sockets.get(g.p2Id);
  if (s1) s1.emit('match_start', { duration: ROUND_DURATION, role: 'p1' });
  if (s2) s2.emit('match_start', { duration: ROUND_DURATION, role: 'p2' });

  setTimeout(()=> maybeStartGameLoop(g, true), 4000);
}

server.listen(PORT, ()=> console.log('Server listening on', PORT));
