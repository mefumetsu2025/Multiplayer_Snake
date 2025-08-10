// server.js
const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROUND_DURATION = 300; // saniye
const TICK_MS = 120;        // oyun tick hızı
const GRID = 20;
const W = 800/GRID; // 40
const H = 600/GRID; // 30

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

// static (client.html'i kökten servis et)
app.use(express.static(path.join(__dirname)));
app.get('/', (req,res)=>res.sendFile(path.join(__dirname, 'client.html')));

// --- Highscores ---
const HS_FILE = path.join(__dirname, 'highscores.json');
function loadHS(){
  try { return JSON.parse(fs.readFileSync(HS_FILE,'utf8')||'[]'); } catch { return []; }
}
function saveHS(arr){
  try { fs.writeFileSync(HS_FILE, JSON.stringify(arr.slice(0,100),null,2)); } catch {}
}
app.get('/highscores', (req,res)=> res.json(loadHS().slice(0,100)) );

// === Oyuncu kayıt & eşleşme altyapısı ===
const waitingQueue = []; // {socketId, nick, ip, botTimer?}
const nickToSocket = new Map(); // eşsiz nick takibi (IP muafiyeti istenirse burada esnetilebilir)
const games = new Map(); // roomId -> game object

// Nick uniqueness: aynı IP aynı nicki kullanabilir, farklı IP kullanamaz
function canUseNick(nick, ip){
  for (const [n, info] of nickToSocket.entries()){
    if (n === nick && info.ip !== ip) return false;
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

    // Kuyruğa al & beklet (5sn sonra bot ile başla, bu arada gerçek rakip gelirse iptal)
    enqueueForMatch(socket, nick, ip);
  });

  socket.on('countdown_done', ()=>{
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const g = games.get(roomId); if (!g) return;
    g.readyFlags[socket.id] = true;
    maybeStartGameLoop(g);
  });

  socket.on('input', payload=>{
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const g = games.get(roomId); if (!g || !g.loopStarted) return;
    const { for: who, dir } = payload || {};
    if (!dir) return;
    // yalnızca kendi yılanını oynatabilsin
    if (who==='p1' && g.p1Id===socket.id) setDir(g.state.p1, dir);
    if (who==='p2' && g.p2Id===socket.id) setDir(g.state.p2, dir);
  });

  socket.on('rematch', ()=>{
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const g = games.get(roomId); if (!g) return;
    g.rematchReady[socket.id] = true;
    tryStartRematch(g);
  });

  socket.on('find_new', ()=>{
    leaveCurrentGame(socket);
    if (socket.data.nick){
      enqueueForMatch(socket, socket.data.nick, ip);
    }
  });

  socket.on('disconnect', ()=>{
    // Kuyruktaysa çıkart
    const qi = waitingQueue.findIndex(x=>x.socketId===socket.id);
    if (qi>=0){
      const w = waitingQueue.splice(qi,1)[0];
      if (w.botTimer) clearTimeout(w.botTimer);
    }
    // Oyundaysa oyunu bitir
    if (socket.data.roomId){
      const g = games.get(socket.data.roomId);
      if (g) endGame(g, socket.id===g.p1Id ? 'p2' : 'p1', 'rakip_ayrildi');
    }
    // nick map temizle
    if (socket.data.nick){
      const info = nickToSocket.get(socket.data.nick);
      if (info && info.socketId===socket.id) nickToSocket.delete(socket.data.nick);
    }
  });
});

// === Matchmaking ===
function enqueueForMatch(socket, nick, ip){
  // Önce bekleyen var mı bak
  // Kendisi hariç ilk uygun kişiyi çek
  const idx = waitingQueue.findIndex(w=>w.socketId!==socket.id);
  if (idx>=0){
    const w = waitingQueue.splice(idx,1)[0];
    if (w.botTimer) clearTimeout(w.botTimer);
    createGame({ p1: w, p2: {socketId: socket.id, nick, ip, isBot:false} });
    return;
  }
  // Yoksa kuyruğa ekle ve 5sn sonra botla başlat
  const entry = { socketId: socket.id, nick, ip, isBot:false, botTimer: null };
  waitingQueue.push(entry);
  entry.botTimer = setTimeout(()=>{
    // Hâlâ kuyruktaysa botla başlat
    const i = waitingQueue.findIndex(w=>w.socketId===socket.id);
    if (i>=0){
      waitingQueue.splice(i,1);
      createGame({ p1: entry, p2: { socketId: 'BOT_'+Date.now(), nick: 'BOT', ip:'-', isBot:true } });
    }
  }, 5000);
}

function leaveCurrentGame(socket){
  const roomId = socket.data.roomId;
  if (!roomId) return;
  const g = games.get(roomId);
  if (!g) return;
  // oyundan çıkan için kaybeden ilan edelim
  endGame(g, socket.id===g.p1Id ? 'p2' : 'p1', 'yeni_rakip_istedi');
}

// === Oyun yaratımı (oda bazlı, eşzamanlı çoklu maç) ===
function createGame({p1, p2}){
  const roomId = 'R'+Math.random().toString(36).slice(2,9);
  const s1 = io.sockets.sockets.get(p1.socketId);
  const isBot2 = !!p2.isBot;

  // Odaya iki tarafı yerleştir (bot soket değil)
  if (s1){ s1.join(roomId); s1.data.roomId=roomId; }
  let s2 = null;
  if (!isBot2){
    s2 = io.sockets.sockets.get(p2.socketId);
    if (s2){ s2.join(roomId); s2.data.roomId=roomId; }
  }

  const state = makeInitialState(p1.nick, p2.nick, isBot2);
  const g = {
    roomId,
    p1Id: s1 ? s1.id : null,
    p2Id: isBot2 ? null : (s2 ? s2.id : null),
    p1Nick: p1.nick,
    p2Nick: p2.nick,
    bot: isBot2,
    loop: null,
    loopStarted: false,
    left: ROUND_DURATION,
    state,
    readyFlags: {},       // countdown_done bekleme
    rematchReady: {}
  };
  games.set(roomId, g);

  // Müşterilere maç başlangıcı
  io.to(roomId).emit('match_start', { duration: ROUND_DURATION });

  // Bot varsa hemen hazır say (countdown sonrası otomatik)
  if (g.p1Id) g.readyFlags[g.p1Id]=false;
  if (!g.p2Id) g.readyFlags['BOT']=true; else g.readyFlags[g.p2Id]=false;

  // Eğer oyuncular countdown_done göndermezse güvenlik olarak 4sn sonra başlat
  setTimeout(()=> maybeStartGameLoop(g, /*force*/true), 4000);
}

// === Başlangıç state ===
function makeInitialState(n1, n2, bot){
  const s = {
    n1, n2,
    p1: snakeAt(5, 10, 1, 0),   // sağa bakan
    p2: snakeAt(34, 19, -1, 0), // sola bakan
    food: randEmptyCell(null, null),
    sfood: null, // özel yem (10 puan)
    nextSpecialAt: pickNextSpecial(10,15,20),
    eatenCount: 0,
    over: false,
    winner: null
  };
  return s;
}
function snakeAt(x, y, dx, dy){
  const body = [];
  for (let i=0;i<5;i++){ body.push({x:x - i*dx, y:y - i*dy}); }
  return { body, dir:{x:dx,y:dy}, pending:0, score:0 };
}
function randEmptyCell(p1, p2){
  const taken = new Set();
  const add = (x,y)=>taken.add(x+','+y);
  if (p1) for (const c of p1.body) add(c.x,c.y);
  if (p2) for (const c of p2.body) add(c.x,c.y);
  while(true){
    const x = (Math.random()*W|0), y = (Math.random()*H|0);
    if (!taken.has(x+','+y)) return {x,y};
  }
}
function pickNextSpecial(...opts){
  return opts[Math.floor(Math.random()*opts.length)];
}

// === Oyunu başlat (countdown_done sonrası) ===
function maybeStartGameLoop(g, force=false){
  if (g.loopStarted) return;
  // force değilse her iki taraf da hazır olmalı (bot her zaman hazır)
  const allReady = force || Object.values(g.readyFlags).every(v => v===true);
  if (!allReady) return;

  g.loopStarted = true;
  g.loop = setInterval(()=> tick(g), TICK_MS);

  // kalan süre sayacı
  g.left = ROUND_DURATION;
  g.leftTimer = setInterval(()=>{
    if (g.state.over){
      clearInterval(g.leftTimer);
      return;
    }
    g.left--;
    if (g.left<=0){
      // süre bitti -> puan karşılaştır
      if (g.state.p1.score > g.state.p2.score) endGame(g, 'p1','sure_bitti');
      else if (g.state.p2.score > g.state.p1.score) endGame(g, 'p2','sure_bitti');
      else endGame(g, 'draw','sure_bitti');
    }
  }, 1000);
}

// === Tick ===
function tick(g){
  const S = g.state;

  // Bot hareketi (sadece p2 bot ise)
  if (g.bot){
    const botDir = botThink(S);
    if (botDir) setDir(S.p2, botDir);
  }

  stepSnake(S.p1);
  stepSnake(S.p2);

  // Çarpmalar
  const p1Dead = isDead(S.p1, S.p2);
  const p2Dead = isDead(S.p2, S.p1);

  // Yem
  handleFood(S, 'p1');
  handleFood(S, 'p2');

  if (p1Dead || p2Dead){
    if (p1Dead && p2Dead){
      // aynı anda çarptı -> beraberlik (skor üstünlüğü olsa bile kural gereği çarpan kaybeder; ikisi de çarptıysa beraber)
      endGame(g, 'draw','carpma');
    } else if (p1Dead){
      endGame(g, 'p2','carpma');
    } else {
      endGame(g, 'p1','carpma');
    }
  }

  // frame publish
  io.to(g.roomId).emit('state', {
    n1: S.n1, n2: S.n2,
    p1: { body:S.p1.body, score:S.p1.score },
    p2: { body:S.p2.body, score:S.p2.score },
    food: S.food, sfood: S.sfood,
    left: g.left,
    over: S.over,
    winner: S.winner
  });
}

function setDir(snake, dir){
  // tersine dönmeyi engelle
  if (snake.dir.x + dir.x === 0 && snake.dir.y + dir.y === 0) return;
  snake.dir = {x: Math.sign(dir.x), y: Math.sign(dir.y)};
}
function stepSnake(s){
  const head = s.body[0];
  const nx = head.x + s.dir.x;
  const ny = head.y + s.dir.y;
  s.body.unshift({x:nx,y:ny});
  if (s.pending>0) s.pending--; else s.body.pop();
}
function isDead(self, other){
  const h = self.body[0];
  // sınır
  if (h.x<0 || h.y<0 || h.x>=W || h.y>=H) return true;
  // kendine çarpma
  for (let i=1;i<self.body.length;i++){
    if (self.body[i].x===h.x && self.body[i].y===h.y) return true;
  }
  // rakibe çarpma
  for (let i=0;i<other.body.length;i++){
    if (other.body[i].x===h.x && other.body[i].y===h.y) return true;
  }
  return false;
}
function handleFood(S, who){
  const me = who==='p1'?S.p1:S.p2;
  if (S.food && me.body[0].x===S.food.x && me.body[0].y===S.food.y){
    me.score += 1;
    me.pending += 1; // her 1 puan 1 uzunluk
    S.eatenCount++;
    // özel yem zamanı mı?
    if (S.eatenCount >= S.nextSpecialAt && !S.sfood){
      S.sfood = randEmptyCell(S.p1, S.p2);
      S.eatenCount = 0;
      S.nextSpecialAt = pickNextSpecial(10,15,20);
    }
    S.food = randEmptyCell(S.p1, S.p2);
  }
  if (S.sfood && me.body[0].x===S.sfood.x && me.body[0].y===S.sfood.y){
    me.score += 10;
    me.pending += 10; // 10 uzunluk
    S.sfood = null;
  }
}

// Basit bot (yeme doğru yaklaş, ölümden kaçın)
function botThink(S){
  const h = S.p2.body[0];
  const target = S.sfood || S.food;
  let best = null, bestDist = Infinity;
  const cand = [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];
  for (const d of cand){
    const nx=h.x+d.x, ny=h.y+d.y;
    const dead = isPointDead({x:nx,y:ny}, S.p2, S.p1);
    if (dead) continue;
    const dist = Math.abs(nx-target.x)+Math.abs(ny-target.y);
    if (dist<bestDist){ bestDist=dist; best=d; }
  }
  // hiçbir güvenli yön yoksa mevcut yönü dene
  return best || S.p2.dir;
}
function isPointDead(h, self, other){
  if (h.x<0 || h.y<0 || h.x>=W || h.y>=H) return true;
  for (let i=0;i<self.body.length;i++) if (self.body[i].x===h.x && self.body[i].y===h.y) return true;
  for (let i=0;i<other.body.length;i++) if (other.body[i].x===h.x && other.body[i].y===h.y) return true;
  return false;
}

// === Oyun bitirme & skor yazma ===
function endGame(g, winner, reason){
  if (!g || g.state.over) return;
  g.state.over = true;
  g.state.winner = winner; // 'p1' | 'p2' | 'draw'

  if (g.loop){ clearInterval(g.loop); g.loop=null; }
  if (g.leftTimer){ clearInterval(g.leftTimer); g.leftTimer=null; }

  // Highscore mantığı:
  // - Bot kazandığında: BOT asla listeye girmez.
  // - İnsan vs bot: insan kazanırsa puanı uygunsa girer.
  // - 2 insan: kazanan uygunsa girer.
  // - Berabere: puan uygunsa her iki insan da girer (bot asla girmez).
  const hs = loadHS();
  const pushIfEligible = (nick, score)=>{
    if (!nick || nick==='BOT') return; // bot hariç
    hs.push({ nick, score, ts: Date.now() });
  };

  if (winner==='p1'){
    pushIfEligible(g.p1Nick, g.state.p1.score);
  } else if (winner==='p2'){
    pushIfEligible(g.p2Nick, g.state.p2.score);
  } else if (winner==='draw'){
    pushIfEligible(g.p1Nick, g.state.p1.score);
    pushIfEligible(g.p2Nick, g.state.p2.score);
  }

  // Skorları sırala (yüksekten düşüğe) ve ilk 100'ü tut
  hs.sort((a,b)=> b.score - a.score || a.ts - b.ts);
  saveHS(hs);

  // Son state publish (over=true)
  io.to(g.roomId).emit('state', {
    n1: g.state.n1, n2: g.state.n2,
    p1: { body:g.state.p1.body, score:g.state.p1.score },
    p2: { body:g.state.p2.body, score:g.state.p2.score },
    food: g.state.food, sfood: g.state.sfood,
    left: g.left,
    over: true,
    winner: g.state.winner
  });

  // Oda devam edebilir, rematch isteklerini bekliyoruz
}

function tryStartRematch(g){
  // her iki taraf rematch'e bastıysa yeni oyun
  const need = [];
  if (g.p1Id) need.push(g.p1Id);
  if (g.p2Id) need.push(g.p2Id);
  const ok = need.every(id => g.rematchReady[id]);

  if (ok){
    // yeni state
    g.state = makeInitialState(g.p1Nick, g.p2Nick, g.bot);
    g.left = ROUND_DURATION;
    g.readyFlags = {};
    g.rematchReady = {};
    if (g.p1Id) g.readyFlags[g.p1Id]=false;
    if (!g.p2Id) g.readyFlags['BOT']=true; else g.readyFlags[g.p2Id]=false;

    io.to(g.roomId).emit('match_start', { duration: ROUND_DURATION });
    setTimeout(()=> maybeStartGameLoop(g, true), 4000);
  } else {
    // kimin hazır olduğunu bilgilendirmek istersen:
    const rdy = { p1: !!g.rematchReady[g.p1Id], p2: g.p2Id ? !!g.rematchReady[g.p2Id] : true };
    io.to(g.roomId).emit('rematch_wait', rdy);
  }
}

server.listen(PORT, ()=> console.log('Server listening on', PORT));
