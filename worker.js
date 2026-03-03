// SketchBattle Worker - WebSocket Game Server
// Deploy ini ke Cloudflare Workers

const WORDS = [
  'apple','banana','car','dog','elephant','fish','guitar','house','island',
  'jungle','kite','lion','mountain','night','ocean','pizza','queen','robot',
  'sun','tree','umbrella','volcano','whale','xylophone','yacht','zebra',
  'airplane','bridge','castle','dragon','eagle','fire','ghost','heart',
  'ice cream','jellyfish','kangaroo','lamp','moon','ninja','owl','penguin',
  'rainbow','snake','tiger','unicorn','violin','waterfall','astronaut',
  'butterfly','cloud','diamond','explosion','forest','galaxy','hammer',
  'igloo','keyboard','lighthouse','magician','notebook','orange','pirate',
  'rocket','sandwich','thunder','vampire','wizard','beach','chocolate',
  'detective','flower','grapes','helicopter','ladder','mirror','noodles',
  'river','spider','tornado','village','window','fox','strawberry',
  'mushroom','panda','cactus','camera','dolphin','feather','giraffe',
  'hoodie','iguana','jewel','koala','lemon','mango','nebula','quill',
];

const ROUND_TIME = 80;
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 8;
const ROUNDS_PER_GAME = 3;

// ─── Durable Object ───────────────────────────────────────────────────
export class GameRoom {
  constructor(state) {
    this.state    = state;
    this.sessions = new Map();   // ws → {id,name,score,isHost,ready}
    this.players  = [];          // ordered ids
    this.gState   = 'waiting';   // waiting|selectingWord|drawing|roundEnd|gameOver
    this.drawer   = null;
    this.word     = null;
    this.round    = 0;
    this.history  = [];
    this.guessed  = new Set();
    this.wordOpts = [];
    this.timeLeft = 0;
    this.timerRef = null;
    this.wsTimeout= null;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket')
      return new Response('Expected WebSocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const sess = this.sessions.get(ws);

    switch (msg.type) {

      case 'join': {
        // FIX: Allow joining waiting rooms. Block only if game is actively running.
        if (this.players.length >= MAX_PLAYERS)
          return this.tx(ws, { type:'error', message:'Room penuh (max 8 pemain)' });
        if (this.gState !== 'waiting')
          return this.tx(ws, { type:'error', message:'Game sudah berjalan, tunggu ronde berikutnya' });

        const id = uid();
        const isHost = this.players.length === 0;
        this.sessions.set(ws, { id, ws, name: (msg.name||'Player').slice(0,20), score:0, isHost, ready:false });
        this.players.push(id);

        this.tx(ws, { type:'joined', playerId:id, isHost, players:this.plist() });
        this.bcast({ type:'playerJoined', player:{ id, name:msg.name }, players:this.plist() }, ws);
        break;
      }

      // NEW: Ready toggle
      case 'toggleReady': {
        if (!sess || this.gState !== 'waiting') return;
        if (sess.isHost) return; // host doesn't need to ready up
        sess.ready = !sess.ready;
        this.bcast({ type:'playerReady', playerId:sess.id, ready:sess.ready, players:this.plist() });
        break;
      }

      case 'startGame': {
        if (!sess?.isHost) return;
        if (this.players.length < MIN_PLAYERS)
          return this.tx(ws, { type:'error', message:`Butuh minimal ${MIN_PLAYERS} pemain` });
        if (this.gState !== 'waiting') return;

        // Check all non-host players are ready
        const nonHosts = [...this.sessions.values()].filter(s => !s.isHost);
        const allReady = nonHosts.every(s => s.ready);
        if (!allReady)
          return this.tx(ws, { type:'error', message:'Belum semua pemain siap!' });

        this.round = 1;
        this.drawer = this.players[0];
        this.startWordSelect();
        break;
      }

      case 'selectWord': {
        if (!sess || sess.id !== this.drawer || this.gState !== 'selectingWord') return;
        if (!this.wordOpts.includes(msg.word)) return;
        this.startDrawing(msg.word);
        break;
      }

      case 'draw': {
        if (!sess || sess.id !== this.drawer || this.gState !== 'drawing') return;
        this.history.push(msg.data);
        this.bcast({ type:'draw', data:msg.data }, ws);
        break;
      }

      case 'clearCanvas': {
        if (!sess || sess.id !== this.drawer) return;
        this.history = [];
        this.bcast({ type:'clearCanvas' }, ws);
        break;
      }

      case 'requestHistory': {
        this.tx(ws, { type:'drawHistory', history:this.history });
        break;
      }

      case 'guess': {
        if (!sess || sess.id === this.drawer || this.gState !== 'drawing') return;
        if (this.guessed.has(sess.id)) return;
        const guess = (msg.guess||'').trim().toLowerCase();
        const target = (this.word||'').toLowerCase();
        if (!guess) return;

        if (guess === target) {
          this.guessed.add(sess.id);
          const pts = Math.max(50, Math.floor(this.timeLeft * 1.5))
                    + Math.max(0, (this.players.length - this.guessed.size) * 10);
          sess.score += pts;
          const drawerSess = this.sessById(this.drawer);
          if (drawerSess) drawerSess.score += 15;

          this.bcast({ type:'correctGuess', playerId:sess.id, playerName:sess.name, score:pts, players:this.plist() });

          const nonDrawers = this.players.filter(p => p !== this.drawer);
          if (this.guessed.size >= nonDrawers.length) this.endRound(true);
        } else {
          this.bcast({ type:'chat', playerId:sess.id, playerName:sess.name,
            message: msg.guess.slice(0,200), isClose: lev(guess, target) <= 2 });
        }
        break;
      }

      case 'chat': {
        if (!sess) return;
        if (this.gState === 'drawing' && sess.id !== this.drawer) return;
        this.bcast({ type:'chat', playerId:sess.id, playerName:sess.name, message:(msg.message||'').slice(0,200) });
        break;
      }

      // NEW: Leave room gracefully
      case 'leaveRoom': {
        if (!sess) return;
        await this.webSocketClose(ws);
        try { ws.close(1000, 'Left room'); } catch {}
        break;
      }
    }
  }

  async webSocketClose(ws) {
    const sess = this.sessions.get(ws);
    if (!sess) return;
    this.sessions.delete(ws);
    this.players = this.players.filter(p => p !== sess.id);

    if (this.players.length === 0) { this.clearTimers(); return; }

    if (sess.isHost) {
      const newHost = this.sessById(this.players[0]);
      if (newHost) newHost.isHost = true;
    }

    this.bcast({ type:'playerLeft', playerId:sess.id, playerName:sess.name, players:this.plist() });

    if (sess.id === this.drawer && this.gState === 'drawing') this.endRound(false);

    if (this.players.length < MIN_PLAYERS && this.gState !== 'waiting') {
      this.clearTimers();
      this.gState = 'waiting';
      // Reset ready state for remaining players
      this.sessions.forEach(s => { s.ready = false; });
      this.bcast({ type:'notEnoughPlayers', players:this.plist() });
    }
  }

  async webSocketError(ws) { await this.webSocketClose(ws); }

  // ── Game flow ──────────────────────────────────────────────────────

  startWordSelect() {
    this.gState   = 'selectingWord';
    this.wordOpts = randWords(3);
    this.guessed  = new Set();
    const drawerSess = this.sessById(this.drawer);
    if (drawerSess) this.tx(drawerSess.ws, { type:'selectWord', words:this.wordOpts });
    this.bcast({ type:'drawerSelecting', drawerName: drawerSess?.name||'?' }, drawerSess?.ws);
    this.wsTimeout = setTimeout(() => {
      if (this.gState === 'selectingWord') this.startDrawing(this.wordOpts[0]);
    }, 15000);
  }

  startDrawing(word) {
    clearTimeout(this.wsTimeout);
    this.word     = word;
    this.gState   = 'drawing';
    this.history  = [];
    this.timeLeft = ROUND_TIME;
    const drawerSess = this.sessById(this.drawer);

    if (drawerSess) this.tx(drawerSess.ws, {
      type:'gameState', state:'drawing', word, isDrawer:true,
      players:this.plist(), timeLeft:this.timeLeft,
      round:this.round, totalRounds:ROUNDS_PER_GAME,
      drawerId:this.drawer, drawerName:drawerSess.name,
    });

    const masked = maskWord(word);
    this.sessions.forEach((s, ws) => {
      if (s.id === this.drawer) return;
      this.tx(ws, {
        type:'gameState', state:'drawing', word:masked,
        wordLength:word.replace(/ /g,'').length, isDrawer:false,
        players:this.plist(), timeLeft:this.timeLeft,
        round:this.round, totalRounds:ROUNDS_PER_GAME,
        drawerId:this.drawer, drawerName:drawerSess?.name,
      });
    });

    this.timerRef = setInterval(() => {
      this.timeLeft--;
      if (this.timeLeft === Math.floor(ROUND_TIME * 0.5) || this.timeLeft === Math.floor(ROUND_TIME * 0.25)) {
        const n = this.timeLeft === Math.floor(ROUND_TIME * 0.5) ? 1 : 2;
        this.bcast({ type:'hint', word: hintWord(word, n) });
      }
      this.bcast({ type:'timer', timeLeft:this.timeLeft });
      if (this.timeLeft <= 0) this.endRound(false);
    }, 1000);
  }

  endRound(allGuessed) {
    this.clearTimers();
    this.gState = 'roundEnd';
    this.bcast({ type:'roundEnd', word:this.word, players:this.plist(), allGuessed });
    setTimeout(() => this.nextTurn(), 5000);
  }

  nextTurn() {
    const idx  = this.players.indexOf(this.drawer);
    const next = (idx + 1) % this.players.length;
    if (next === 0) this.round++;
    if (this.round > ROUNDS_PER_GAME) { this.endGame(); return; }
    this.drawer = this.players[next];
    this.startWordSelect();
  }

  endGame() {
    this.gState = 'gameOver';
    const sorted = this.plist().sort((a,b) => b.score - a.score);
    this.bcast({ type:'gameOver', players:sorted });
    setTimeout(() => {
      this.sessions.forEach(s => { s.score = 0; s.ready = false; });
      this.gState = 'waiting'; this.round = 0;
      this.drawer = null; this.word = null; this.history = [];
      this.bcast({ type:'lobby', players:this.plist() });
    }, 10000);
  }

  clearTimers() {
    clearInterval(this.timerRef); clearTimeout(this.wsTimeout);
    this.timerRef = null; this.wsTimeout = null;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  tx(ws, msg) { try { ws.send(JSON.stringify(msg)); } catch {} }

  bcast(msg, skip = null) {
    this.sessions.forEach((s, ws) => { if (ws !== skip) this.tx(ws, msg); });
  }

  sessById(id) {
    for (const [, s] of this.sessions) if (s.id === id) return s;
    return null;
  }

  plist() {
    return this.players.map(id => {
      const s = this.sessById(id);
      return s ? { id:s.id, name:s.name, score:s.score, isHost:s.isHost, isDrawing:this.drawer===s.id, ready:s.ready } : null;
    }).filter(Boolean);
  }
}

// ─── Worker Entry ────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

    if (url.pathname.startsWith('/ws/')) {
      const roomId = url.pathname.slice(4).toUpperCase();
      if (!roomId || roomId.length < 4) return new Response('Invalid room', { status:400 });
      const id   = env.ROOMS.idFromName(roomId);
      const stub = env.ROOMS.get(id);
      return stub.fetch(req);
    }

    if (url.pathname === '/health')
      return new Response(JSON.stringify({ ok:true }), { headers:{ 'Content-Type':'application/json', ...cors } });

    return new Response('SketchBattle Worker 🎨', { headers: cors });
  }
};

// ─── Utils ───────────────────────────────────────────────────────────
function uid() { return Math.random().toString(36).slice(2,10); }
function randWords(n) { return [...WORDS].sort(()=>Math.random()-.5).slice(0,n); }
function maskWord(w) { return w.split('').map(c => c===' ' ? ' ' : '_').join(''); }
function hintWord(word, n) {
  const chars = word.split('');
  const idxs  = chars.map((c,i)=>c!==' '?i:-1).filter(i=>i!==-1);
  const show  = new Set([...idxs].sort(()=>Math.random()-.5).slice(0,n));
  return chars.map((c,i)=>c===' '?' ':show.has(i)?c:'_').join('');
}
function lev(a, b) {
  const m=a.length, n=b.length;
  const dp=Array.from({length:m+1},(_,i)=>Array.from({length:n+1},(_,j)=>i===0?j:j===0?i:0));
  for(let i=1;i<=m;i++) for(let j=1;j<=n;j++)
    dp[i][j]=a[i-1]===b[j-1]?dp[i-1][j-1]:1+Math.min(dp[i-1][j],dp[i][j-1],dp[i-1][j-1]);
  return dp[m][n];
}
