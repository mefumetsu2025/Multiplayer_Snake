// Snake Multiplayer – Geri Sayım (countdown_done), Bot, Kalıcı Highscore (JSON),
// Benzersiz Nick (aynı IP serbest), 15 karakter sınırı, yasaklı kelime filtresi
const path = require('path');
const fs = require('fs').promises;
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const GRID_W = 40, GRID_H = 30;
const TICK_MS = 100;
const DURATION_SEC = 300;      // oyun süresi (geri sayım hariç)
const COUNTDOWN_SEC = 3;       // 3-2-1
const BOT_DELAY_MS = 1500;     // 1.5 sn bekleme -> botla başla

const HS_PATH = path.join(__dirname, 'highscores.json');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'client.html')));

// ---- Highscores (kalıcı) ----
let highscores = [];
async function loadHighscores() {
  try {
    const s = await fs.readFile(HS_PATH, 'utf8');
    const data = JSON.parse(s);
    if (Array.isArray(data)) highscores = data;
  } catch (_) {
    highscores = [];
  }
}
async function saveHighscores() {
  try {
    const tmp = HS_PATH + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(highscores, null, 2), 'utf8');
    await fs.rename(tmp, HS_PATH); // atomik kayıt
  } catch (e) {
    console.error('Highscore kaydedilemedi:', e.message);
  }
}
function addHighscore(nick, score){
  if (!nick || nick.toLowerCase() === 'bot') return; // botu asla yazma
  highscores.push({ nick, score, at: new Date().toISOString() });
  highscores.sort((a,b)=>b.score-a.score);
  highscores = highscores.slice(0,100);
  saveHighscores();
}
app.get('/highscores', (_,res)=>res.json(highscores));

// ---- Yasaklı kelimeler ----
const bannedWords = [
  "sex","porno","porn","sik","orospu","amcık","amq","göt","aq","fuck","shit","asshole",
  "dick","pussy","cunt","bitch","nigger","cock","cum","xxx"
];

// ---- Nick benzersiz (aynı IP aynı adı kullanabilir) ----
const activeNickOwners = new Map(); // lowerNick -> Set<ip>
const clientIp = sock => (sock.handshake.address || '').replace(/^::ffff:/,'') || '0.0.0.0';

// ---- Eşleşme ve oyun durumları ----
const waitingQueue = [];              // socket.id listesi
const rooms = new Map();              // roomId -> state

function makeRoomId(){ return 'r_' + Math.random().toString(36).slice(2,9); }
function newSnake(x,y,dx,dy){
  const b=[]; for(let i=0;i<5;i++) b.push({x:x-i*dx, y:y-i*dy});
  return {
    body:b, dir:{x:dx,y:dy}, nextDir:{x:dx,y:dy}, score:0, growBy:0,
    stats:{ normal:0, special:0, moves:0 }
  };
}
function buildOcc(st){ const s=new Set(); for(const p of st.p1.body) s.add(p.x+','+p.y); for(const p of st.p2.body) s.add(p.x+','+p.y); return s; }
function emptyCell(st){ let g=0; while(g++<2000){ const x=(Math.random()*GRID_W)|0, y=(Math.random()*GRID_H)|0; if(!st.occ.has(x+','+y)) return {x,y}; } return {x:1,y:1}; }

function baseState(){
  const now = Date.now();
  const st={
    createdAt: now,
    // startsAt başlangıçta ileri alınır; ama gerçek başlama, countdown_done bayraklarıyla kontrol edilir
    startsAt: now + COUNTDOWN_SEC*1000,
    endsAt:   now + COUNTDOWN_SEC*1000 + DURATION_SEC*1000,
    tick:0,
    p1:newSnake(5,5,1,0), p2:newSnake(GRID_W-6,GRID_H-6,-1,0),
    food:null, sfood:null, sfoodExpireAt:0, winner:null, over:false, scored:false,
    ready1:false, ready2:false, nick1:"Siyah", nick2:"Gri",
    botSide:null,                 // "p1" veya "p2"
    cd1:false, cd2:false          // countdown_done bayrakları
  };
  st.occ = buildOcc(st); st.food = emptyCell(st);
  return st;
}
function start(roomId){ const st=baseState(); st.roomId=roomId; rooms.set(roomId, st); }
function restartInSameRoom(roomId){
  const old=rooms.get(roomId); if(!old) return;
  const st=baseState(); st.roomId=roomId;
  st.p1id=old.p1id; st.p2id=old.p2id;
  st.nick1=old.nick1; st.nick2=old.nick2;
  st.botSide=old.botSide;
  rooms.set(roomId, st);
  io.to(roomId).emit('match_start', { roomId, duration:DURATION_SEC, countdown:COUNTDOWN_SEC, n1:st.nick1, n2:st.nick2 });
}
function setDir(s, nx, ny){
  if ((nx===1 && s.dir.x===-1) || (nx===-1 && s.dir.x===1) || (ny===1 && s.dir.y===-1) || (ny===-1 && s.dir.y===1)) return;
  s.nextDir = {x:nx, y:ny};
}

// ---- BOT AI ----
function botThink(st, side){
  const me = side==='p2'? st.p2 : st.p1;
  const rival = side==='p2'? st.p1 : st.p2;
  const target = st.sfood || st.food;
  if(!target) return;

  const head = me.body[0];
  const dx = target.x - head.x, dy = target.y - head.y;
  const primaryX = Math.abs(dx) >= Math.abs(dy);

  const cand = [];
  if (primaryX){
    cand.push({x:Math.sign(dx)||0,y:0});
    cand.push({x:0,y:Math.sign(dy)||0});
  } else {
    cand.push({x:0,y:Math.sign(dy)||0});
    cand.push({x:Math.sign(dx)||0,y:0});
  }
  cand.push({x: me.dir.y, y: -me.dir.x});
  cand.push({x: -me.dir.y, y: me.dir.x});
  cand.push(me.dir);

  for(const d of cand){
    if(isOpposite(me.dir,d)) continue;
    const nx = head.x + d.x, ny = head.y + d.y;
    if(!willCrash(nx,ny, me, rival)) { setDir(me, d.x, d.y); return; }
  }
  const dirs = [{x:1,y:0},{x:-1,y:0},{x:0,y:1},{x:0,y:-1}];
  for(const d of dirs){
    if(isOpposite(me.dir,d)) continue;
    const nx=head.x+d.x, ny=head.y+d.y;
    if(!willCrash(nx,ny, me, rival)) { setDir(me,d.x,d.y); return; }
  }
}
function isOpposite(a,b){ return (a.x===1&&b.x===-1)||(a.x===-1&&b.x===1)||(a.y===1&&b.y===-1)||(a.y===-1&&b.y===1); }
function willCrash(nx,ny, me, rival){
  if(nx<0||nx>=GRID_W||ny<0||ny>=GRID_H) return true;
  for(let i=0;i<me.body.length;i++) if(me.body[i].x===nx && me.body[i].y===ny) return true;
  for(const p of rival.body) if(p.x===nx && p.y===ny) return true;
  return false;
}

// Geri sayım senk.: oynanabilir mi?
function isPlayable(st){
  if (Date.now() < st.startsAt) return false; // zaman dolmadan asla
  if (st.botSide){ // bot maçında tek oyuncu yeter
    return st.botSide==='p1' ? st.cd2 : st.cd1;
  }
  // iki gerçek oyuncu
  return st.cd1 && st.cd2;
}

function step(st){
  if (st.over) return;
  st.tick++;

  // Geri sayım/senkron kontrolü
  if (!isPlayable(st)) return;

  // Bot hamlesi
  if(st.botSide==='p2') botThink(st,'p2');
  else if(st.botSide==='p1') botThink(st,'p1');

  // Zaman bitti mi?
  if (Date.now() >= st.endsAt){
    st.winner = st.p1.score>st.p2.score ? 'p1' : st.p2.score>st.p1.score ? 'p2' : 'tie';
    st.over = true;
  }

  // Hareket
  for (const s of [st.p1, st.p2]){
    s.dir = s.nextDir;
    const h = { x: s.body[0].x + s.dir.x, y: s.body[0].y + s.dir.y };
    s.body.unshift(h);
    if (s.growBy > 0) s.growBy--; else s.body.pop();
    s.stats.moves++; // (artık istemiyorsan client göstermiyor; bırakmak sorun değil)
  }

  // Kafa çarpışması
  const h1 = st.p1.body[0], h2 = st.p2.body[0];
  if (h1.x===h2.x && h1.y===h2.y){ st.winner='tie'; st.over=true; }

  const wallOrSelf = s => {
    const h=s.body[0];
    if (h.x<0||h.x>=GRID_W||h.y<0||h.y>=GRID_H) return true;
    for (let i=1;i<s.body.length;i++) if (h.x===s.body[i].x && h.y===s.body[i].y) return true;
    return false;
  };
  const hitOther = (a,b) => {
    const h=a.body[0];
    for (const p of b.body) if (h.x===p.x && h.y===p.y) return true;
    return false;
  };

  const p1Crash = wallOrSelf(st.p1) || hitOther(st.p1, st.p2);
  const p2Crash = wallOrSelf(st.p2) || hitOther(st.p2, st.p1);
  if (!st.over){
    if (p1Crash && !p2Crash){ st.winner='p2'; st.over=true; }
    else if (p2Crash && !p1Crash){ st.winner='p1'; st.over=true; }
    else if (p1Crash && p2Crash){ st.winner='tie'; st.over=true; }
  }

  // Yem
  const eat = s => {
    const h=s.body[0];
    if (st.food && h.x===st.food.x && h.y===st.food.y){
      s.score++; s.growBy++; st.food=emptyCell(st); s.stats.normal++;
      if (!st.sfood && Math.random()<0.20){ st.sfood=emptyCell(st); st.sfoodExpireAt=Date.now()+10000; }
    }
    if (st.sfood && h.x===st.sfood.x && h.y===st.sfood.y){
      s.score+=10; s.growBy+=10; st.sfood=null; st.sfoodExpireAt=0; s.stats.special++;
    }
  };
  if (!st.over){ eat(st.p1); eat(st.p2); }
  if (st.sfood && Date.now()>st.sfoodExpireAt){ st.sfood=null; st.sfoodExpireAt=0; }

  st.occ = buildOcc(st);

  // Skor yazımı oyun bitince (Top100 kuralları)
  if (st.over && !st.scored){
    st.scored = true;

    const isBotP1 = (st.nick1||'').toLowerCase()==='bot';
    const isBotP2 = (st.nick2||'').toLowerCase()==='bot';

    if (st.winner==='p1'){
      if (!isBotP1) addHighscore(st.nick1, st.p1.score);
    } else if (st.winner==='p2'){
      if (!isBotP2) addHighscore(st.nick2, st.p2.score);
    } else { // tie
      if (!isBotP1) addHighscore(st.nick1, st.p1.score);
      if (!isBotP2) addHighscore(st.nick2, st.p2.score);
    }
  }
}

// ---- Socket.IO ----
io.on('connection', (sock)=>{
  // Nick alma + doğrulama
  sock.on('set_nick', (nick)=>{
    const raw = (nick ?? '').toString();
    const trimmed = raw.trim();
    if (!trimmed){ sock.emit('nick_error','Kullanıcı adı boş olamaz!'); return; }
    if (trimmed.length > 15){ sock.emit('nick_error','Kullanıcı adı en fazla 15 karakter olabilir.'); return; }
    const lower = trimmed.toLowerCase();
    const ip = clientIp(sock);
    const owners = activeNickOwners.get(lower) || new Set();
    if (owners.size>0 && !owners.has(ip)){ sock.emit('nick_error','Bu kullanıcı adı kullanımda.'); return; }
    if (bannedWords.some(w=>lower.includes(w))){ sock.emit('nick_error','Bu isim yasaklı/müstehcen kelime içeriyor.'); return; }

    owners.add(ip);
    activeNickOwners.set(lower, owners);
    sock.data.nickname = trimmed;
    sock.data.lowerNick = lower;
    sock.data.ip = ip;

    waitingQueue.push(sock.id);

    // BOT zamanlayıcısı
    sock.data.botTimer = setTimeout(()=>{
      const idx = waitingQueue.indexOf(sock.id);
      if(idx !== -1){ waitingQueue.splice(idx,1); startBotMatch(sock); }
    }, BOT_DELAY_MS);

    match(); // normal eşleşme varsa hemen eşleştirir
  });

  // Geri sayım bitti sinyali (tek oyuncu bot vs ise bir kişi yeter)
  sock.on('countdown_done', ()=>{
    const st = rooms.get(sock.data.roomId); if(!st) return;
    if (sock.id === st.p1id) st.cd1 = true;
    else if (sock.id === st.p2id) st.cd2 = true;

    // İki taraf da hazır olduysa (veya bot maçında tek taraf) başlama zamanını "şimdi"ye çek
    if (isPlayable(st)) {
      // startsAt geçmiş olabilir; sorun değil. Oyunu gecikmesiz başlatmak için güncelle.
      st.startsAt = Math.min(st.startsAt, Date.now());
      // endsAt'i de buna göre kaydır: süremiz DURATION_SEC kadar sabit kalsın
      const remain = st.endsAt - st.startsAt; // planlanan gerçek süre
      st.endsAt = Date.now() + Math.max(0, remain);
    }
  });

  sock.on('input', (msg)=>{
    const st = rooms.get(sock.data.roomId); if(!st || st.over) return;
    if (!isPlayable(st)) return; // countdown tamamlanmadan input yok
    if (st.botSide && msg.for === st.botSide) return; // botu kullanıcı oynatamaz
    if (msg && msg.dir && (msg.for==='p1'||msg.for==='p2')){
      const s = msg.for==='p1' ? st.p1 : st.p2;
      setDir(s, msg.dir.x|0, msg.dir.y|0);
    }
  });

  // Rematch
  sock.on('rematch', ()=>{
    const rid = sock.data.roomId; const st = rid?rooms.get(rid):null; if(!st) return;
    if (st.botSide){ // bot maçında tek tıkla rematch
      restartInSameRoom(rid);
    } else {
      if (sock.id===st.p1id) st.ready1=true;
      if (sock.id===st.p2id) st.ready2=true;
      io.to(rid).emit('rematch_wait', {p1:!!st.ready1, p2:!!st.ready2});
      if (st.ready1 && st.ready2) restartInSameRoom(rid);
    }
  });

  // Yeni rakip
  sock.on('find_new', ()=>{
    const rid = sock.data.roomId;
    if (rid){
      const st = rooms.get(rid);
      if (st && !st.over){
        st.winner = (sock.id === st.p1id) ? 'p2' : 'p1';
        st.over = true;
      }
      sock.leave(rid);
      sock.data.roomId = null;
    }
    waitingQueue.push(sock.id);
    if (sock.data.botTimer) clearTimeout(sock.data.botTimer);
    sock.data.botTimer = setTimeout(()=>{
      const idx = waitingQueue.indexOf(sock.id);
      if(idx !== -1){ waitingQueue.splice(idx,1); startBotMatch(sock); }
    }, BOT_DELAY_MS);
    match();
  });

  sock.on('disconnect', ()=>{
    const lower = sock.data?.lowerNick;
    const ip = sock.data?.ip;
    if (lower && activeNickOwners.has(lower)){
      const set = activeNickOwners.get(lower);
      set.delete(ip);
      if (set.size===0) activeNickOwners.delete(lower);
    }
    if (sock.data?.botTimer) clearTimeout(sock.data.botTimer);

    const rid = sock.data?.roomId;
    if (rid && rooms.has(rid)){
      const st = rooms.get(rid);
      if (!st.over){
        st.winner = (sock.id === st.p1id) ? 'p2' : 'p1';
        st.over = true;
      }
    }
  });
});

// ---- Oyun döngüsü ----
setInterval(()=>{
  for (const [rid, st] of rooms){
    step(st);

    const now = Date.now();
    const countdownLeft = Math.max(0, Math.ceil((st.startsAt - now)/1000));
    const left = st.over ? Math.max(0, Math.ceil((st.endsAt - st.startsAt)/1000) - DURATION_SEC + DURATION_SEC) // gönderilen değer kullanılmıyor ama tutarlılık için
                         : Math.max(0, Math.ceil((st.endsAt - now)/1000));

    io.to(rid).emit('state',{
      tick: st.tick,
      countdownLeft,
      left,
      food: st.food, sfood: st.sfood,
      p1:{ body: st.p1.body, score: st.p1.score, stats: st.p1.stats },
      p2:{ body: st.p2.body, score: st.p2.score, stats: st.p2.stats },
      over: st.over, winner: st.winner, n1: st.nick1, n2: st.nick2
    });

    if (st.over && !st._cleanup){ st._cleanup=true; setTimeout(()=>rooms.delete(rid), 600000); }
  }
}, TICK_MS);

// ---- Eşleştirme ----
function match(){
  while (waitingQueue.length >= 2){
    const s1 = io.sockets.sockets.get(waitingQueue.shift());
    const s2 = io.sockets.sockets.get(waitingQueue.shift());
    if(!s1 || !s2) continue;

    if (s1.data?.botTimer) clearTimeout(s1.data.botTimer);
    if (s2.data?.botTimer) clearTimeout(s2.data.botTimer);

    const rid = makeRoomId();
    s1.join(rid); s2.join(rid);
    s1.data.roomId = rid; s2.data.roomId = rid;

    start(rid);
    const st = rooms.get(rid);
    st.p1id = s1.id; st.p2id = s2.id;
    st.nick1 = s1.data.nickname || 'Siyah';
    st.nick2 = s2.data.nickname || 'Gri';
    io.to(rid).emit('match_start', { roomId: rid, duration: DURATION_SEC, countdown: COUNTDOWN_SEC, n1: st.nick1, n2: st.nick2 });
  }
}

// Tek oyuncuya botla oda aç
function startBotMatch(sock){
  const rid = makeRoomId();
  sock.join(rid);
  sock.data.roomId = rid;

  start(rid);
  const st = rooms.get(rid);
  st.p1id = sock.id;
  st.p2id = null;           // bot
  st.nick1 = sock.data.nickname || 'Siyah';
  st.nick2 = 'Bot';
  st.botSide = 'p2';        // griyi bot oynar

  io.to(rid).emit('match_start', { roomId: rid, duration: DURATION_SEC, countdown: COUNTDOWN_SEC, n1: st.nick1, n2: st.nick2 });
}

// ---- Sunucu başlat ----
loadHighscores().then(()=>{
  server.listen(PORT, ()=> console.log(`Server running at http://localhost:${PORT}`));
});
