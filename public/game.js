'use strict';

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const SIZE = 10;
const LETTERS = 'ABCDEFGHIJ';
const FLEET = [
  { id: 'portaaviones', name: 'Portaaviones', size: 5 },
  { id: 'acorazado', name: 'Acorazado', size: 4 },
  { id: 'crucero', name: 'Crucero', size: 3 },
  { id: 'submarino', name: 'Submarino', size: 3 },
  { id: 'destructor', name: 'Destructor', size: 2 },
];
// Sin I, L, O, 0 ni 1 para que no haya confusiones al dictarlo.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 5;
const PING_EVERY_MS = 15000;
const PONG_TIMEOUT_MS = 8000;
const MAX_RETRY_MS = 8000;
// Intentos fallidos antes de rendirse al crear o unirse a una partida.
const MAX_INITIAL_FAILURES = 4;

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const key = (x, y) => `${x},${y}`;
const randInt = (n) => Math.floor(Math.random() * n);
const coordName = (x, y) => `${LETTERS[x]}${y + 1}`;
const validCoord = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < SIZE && y < SIZE;

function randomCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

function cleanName(raw) {
  const name = String(raw || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return name || 'Rival';
}

function storageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function storageSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ }
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

const S = {
  // Conexión con la sala (ver src/worker.js)
  ws: null,
  wsReady: false,
  token: null,
  outSeq: 0, // último mensaje propio numerado
  outbox: [], // mensajes propios que la sala todavía no confirmó
  inSeq: 0, // último mensaje del rival procesado
  peerOnline: false,
  heardFromEnemy: false,
  failures: 0,
  retryTimer: null,
  pingTimer: null,
  pongTimer: null,
  role: null, // 'host' | 'guest'
  code: null,
  myName: '',
  enemyName: 'Rival',
  phase: 'lobby', // lobby | creating | joining | waiting | placing | playing | over | closed
  ships: [], // { id, name, size, cells: [{x, y}], hits }
  horizontal: true,
  selected: 0, // índice en FLEET del barco a ubicar, -1 si no hay
  hover: null,
  incoming: new Map(), // disparos recibidos: key -> 'hit' | 'miss'
  outgoing: new Map(), // disparos hechos: key -> 'hit' | 'miss' | 'sunk'
  revealed: new Set(), // barcos del rival mostrados al terminar
  enemySunk: [],
  myReady: false,
  enemyReady: false,
  myTurn: false,
  pendingShot: null,
  lastEvent: '',
  rematchMe: false,
  rematchEnemy: false,
};

// ---------------------------------------------------------------------------
// Elementos
// ---------------------------------------------------------------------------

const els = {
  screens: { lobby: $('#lobby'), waiting: $('#waiting'), game: $('#game') },
  name: $('#name'),
  btnCreate: $('#btn-create'),
  joinForm: $('#join-form'),
  joinCode: $('#join-code'),
  btnJoin: $('#btn-join'),
  lobbyMsg: $('#lobby-msg'),
  btnLobbyCancel: $('#btn-lobby-cancel'),
  codeDisplay: $('#code-display'),
  waitingNote: $('#waiting-note'),
  btnCopy: $('#btn-copy'),
  btnShare: $('#btn-share'),
  btnCancel: $('#btn-cancel'),
  vs: $('#vs'),
  gameCode: $('#game-code'),
  btnLeave: $('#btn-leave'),
  netBanner: $('#net-banner'),
  status: $('#status'),
  placement: $('#placement'),
  shipList: $('#ship-list'),
  btnRotate: $('#btn-rotate'),
  btnRandom: $('#btn-random'),
  btnClear: $('#btn-clear'),
  btnReady: $('#btn-ready'),
  endActions: $('#end-actions'),
  btnRematch: $('#btn-rematch'),
  btnHome: $('#btn-home'),
  boards: $('#boards'),
  myBoard: $('#my-board'),
  enemyBoard: $('#enemy-board'),
  enemyWrap: $('#enemy-wrap'),
  enemyFleet: $('#enemy-fleet'),
  chatLog: $('#chat-log'),
  chatForm: $('#chat-form'),
  chatInput: $('#chat-input'),
  overlay: $('#overlay'),
  overlayTitle: $('#overlay-title'),
  overlayText: $('#overlay-text'),
  overlayActions: $('#overlay-actions'),
};

function showScreen(name) {
  for (const [n, el] of Object.entries(els.screens)) el.hidden = n !== name;
}

function lobbyMsg(text, isError = false) {
  els.lobbyMsg.textContent = text;
  els.lobbyMsg.classList.toggle('error', isError);
}

function setLobbyBusy(busy) {
  els.btnCreate.disabled = busy;
  els.btnJoin.disabled = busy;
  els.btnLobbyCancel.hidden = !busy;
}

function showOverlay(title, text, actions) {
  els.overlayTitle.textContent = title;
  els.overlayText.textContent = text;
  els.overlayActions.replaceChildren(...actions.map(({ label, primary, onClick }) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', onClick);
    return b;
  }));
  els.overlay.hidden = false;
  els.overlayActions.querySelector('button')?.focus();
}

function hideOverlay() {
  els.overlay.hidden = true;
}

// ---------------------------------------------------------------------------
// Flota
// ---------------------------------------------------------------------------

function shipCells(x, y, size, horizontal) {
  const cells = [];
  for (let i = 0; i < size; i++) cells.push(horizontal ? { x: x + i, y } : { x, y: y + i });
  return cells;
}

function shipAt(x, y, ships = S.ships) {
  return ships.find((s) => s.cells.some((c) => c.x === x && c.y === y));
}

function canPlace(cells, ships = S.ships) {
  return cells.every((c) => validCoord(c.x, c.y) && !shipAt(c.x, c.y, ships));
}

function touchesOther(cells, ships) {
  return cells.some((c) => {
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        if (shipAt(c.x + dx, c.y + dy, ships)) return true;
      }
    }
    return false;
  });
}

// Corrige la posición para que el barco entre en el tablero (útil en celulares).
function placementFor(x, y, size, horizontal) {
  const sx = horizontal ? Math.min(x, SIZE - size) : x;
  const sy = horizontal ? y : Math.min(y, SIZE - size);
  return shipCells(sx, sy, size, horizontal);
}

function randomFleet() {
  const ships = [];
  for (const f of FLEET) {
    for (let tries = 0; ; tries++) {
      const horizontal = Math.random() < 0.5;
      const cells = shipCells(randInt(SIZE), randInt(SIZE), f.size, horizontal);
      // Primero intenta que no se toquen; si no se puede, se conforma con que no se pisen.
      if (canPlace(cells, ships) && (tries > 300 || !touchesOther(cells, ships))) {
        ships.push({ ...f, cells, hits: 0 });
        break;
      }
    }
  }
  return ships;
}

function nextUnplaced() {
  return FLEET.findIndex((f) => !S.ships.some((s) => s.id === f.id));
}

function allPlaced() {
  return S.ships.length === FLEET.length;
}

// ---------------------------------------------------------------------------
// Tableros
// ---------------------------------------------------------------------------

function buildBoard(container, onCell) {
  const cells = [];
  const frag = document.createDocumentFragment();
  const label = (text) => {
    const d = document.createElement('div');
    d.className = 'label';
    d.textContent = text;
    return d;
  };
  frag.append(label(''));
  for (let x = 0; x < SIZE; x++) frag.append(label(LETTERS[x]));
  for (let y = 0; y < SIZE; y++) {
    frag.append(label(String(y + 1)));
    cells.push([]);
    for (let x = 0; x < SIZE; x++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cell';
      b.dataset.x = x;
      b.dataset.y = y;
      b.setAttribute('aria-label', coordName(x, y));
      cells[y].push(b);
      frag.append(b);
    }
  }
  container.replaceChildren(frag);
  container.addEventListener('click', (e) => {
    const b = e.target.closest('.cell');
    if (b && !b.disabled) onCell(Number(b.dataset.x), Number(b.dataset.y));
  });
  return cells;
}

const myCells = buildBoard(els.myBoard, onMyBoardClick);
const enemyCells = buildBoard(els.enemyBoard, shoot);

els.myBoard.addEventListener('mouseover', (e) => {
  const b = e.target.closest('.cell');
  if (!b || S.phase !== 'placing') return;
  S.hover = { x: Number(b.dataset.x), y: Number(b.dataset.y) };
  renderMyBoard();
});
els.myBoard.addEventListener('mouseleave', () => {
  S.hover = null;
  renderMyBoard();
});

function previewCells() {
  if (S.phase !== 'placing' || S.myReady || !S.hover || S.selected < 0) return null;
  const f = FLEET[S.selected];
  if (shipAt(S.hover.x, S.hover.y)) return null;
  const cells = placementFor(S.hover.x, S.hover.y, f.size, S.horizontal);
  return { cells, ok: canPlace(cells) };
}

function renderMyBoard() {
  const placing = S.phase === 'placing' && !S.myReady;
  const preview = previewCells();
  const previewKeys = new Set(preview ? preview.cells.map((c) => key(c.x, c.y)) : []);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const k = key(x, y);
      const cls = ['cell'];
      const ship = shipAt(x, y);
      if (ship) {
        cls.push('ship', ship.cells[0].y === ship.cells[ship.size - 1].y ? 'h' : 'v');
        const i = ship.cells.findIndex((c) => c.x === x && c.y === y);
        if (i === 0) cls.push('bow');
        if (i === ship.size - 1) cls.push('stern');
        if (ship.hits === ship.size) cls.push('sunk');
      }
      const shot = S.incoming.get(k);
      if (shot === 'hit' && !(ship && ship.hits === ship.size)) cls.push('hit');
      if (shot === 'miss') cls.push('miss');
      if (placing) cls.push('placing');
      if (previewKeys.has(k)) cls.push(preview.ok ? 'preview' : 'preview-bad');
      const b = myCells[y][x];
      b.className = cls.join(' ');
      b.disabled = !placing;
    }
  }
}

function renderEnemyBoard() {
  const canShoot = S.phase === 'playing' && S.myTurn && !S.pendingShot;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const k = key(x, y);
      const cls = ['cell'];
      const shot = S.outgoing.get(k);
      if (shot) cls.push(shot);
      else if (S.revealed.has(k)) cls.push('reveal');
      const pending = S.pendingShot && S.pendingShot.x === x && S.pendingShot.y === y;
      if (pending) cls.push('pending');
      const target = canShoot && !shot;
      if (target) cls.push('target');
      const b = enemyCells[y][x];
      b.className = cls.join(' ');
      b.disabled = !target;
    }
  }
  els.enemyBoard.classList.toggle('active', canShoot);
}

function pips(size) {
  const span = document.createElement('span');
  span.className = 'pips';
  for (let i = 0; i < size; i++) span.append(document.createElement('i'));
  return span;
}

function renderShipList() {
  els.shipList.replaceChildren(...FLEET.map((f, i) => {
    const li = document.createElement('li');
    const placed = S.ships.some((s) => s.id === f.id);
    if (placed) li.classList.add('placed');
    if (i === S.selected) li.classList.add('selected');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = f.name;
    li.append(name, pips(f.size));
    li.addEventListener('click', () => {
      if (S.myReady || placed) return;
      S.selected = i;
      render();
    });
    return li;
  }));
}

function renderEnemyFleet() {
  const sunk = [...S.enemySunk];
  els.enemyFleet.replaceChildren(...FLEET.map((f) => {
    const li = document.createElement('li');
    const i = sunk.indexOf(f.name);
    if (i >= 0) {
      li.classList.add('sunk');
      sunk.splice(i, 1);
    }
    li.append(f.name, pips(f.size));
    return li;
  }));
}

function statusText() {
  const enemy = S.enemyName;
  switch (S.phase) {
    case 'placing':
      if (S.myReady) return `Flota lista. Esperando a que ${enemy} ubique sus barcos…`;
      if (allPlaced()) {
        return `¡Flota ubicada! Tocá «¡Listo!» para empezar.${S.enemyReady ? ` ${enemy} ya está esperando.` : ''}`;
      }
      return `Ubicá tu ${FLEET[S.selected].name.toLowerCase()} (${FLEET[S.selected].size} casillas). ` +
        'Tocá un barco ya puesto para moverlo.' + (S.enemyReady ? ` ${enemy} ya está esperando.` : '');
    case 'playing': {
      const turn = S.myTurn ? '🎯 Tu turno: elegí dónde disparar.' : `⏳ Turno de ${enemy}…`;
      return S.lastEvent ? `${S.lastEvent} ${turn}` : turn;
    }
    case 'over':
      if (S.rematchMe) return `Esperando que ${enemy} acepte la revancha…`;
      if (S.rematchEnemy) return `${enemy} quiere la revancha. ¿Jugamos otra?`;
      return S.lastEvent || 'Partida terminada.';
    default:
      return '';
  }
}

function render() {
  if (S.phase === 'lobby' || S.phase === 'waiting') return;
  els.vs.textContent = `${S.myName} vs. ${S.enemyName}`;
  els.gameCode.textContent = S.code;
  els.status.textContent = statusText();
  els.status.classList.toggle('my-turn', S.phase === 'playing' && S.myTurn);

  const placing = S.phase === 'placing';
  els.placement.hidden = !placing || S.myReady;
  els.endActions.hidden = S.phase !== 'over';
  els.btnRematch.disabled = S.rematchMe;
  els.btnRematch.textContent = S.rematchEnemy ? 'Aceptar revancha' : 'Revancha';
  els.enemyWrap.classList.toggle('inactive', placing);
  els.boards.classList.toggle('playing', S.phase === 'playing');
  els.btnReady.disabled = !allPlaced();

  renderShipList();
  renderMyBoard();
  renderEnemyBoard();
  renderEnemyFleet();
  updateTitle();
}

function updateTitle() {
  const myTurn = S.phase === 'playing' && S.myTurn;
  document.title = myTurn && document.hidden ? '🎯 ¡Tu turno! · Batalla Naval' : 'Batalla Naval';
}
document.addEventListener('visibilitychange', updateTitle);

function boom(cell) {
  cell.classList.remove('boom');
  void cell.offsetWidth;
  cell.classList.add('boom');
}

// ---------------------------------------------------------------------------
// Ubicación de barcos
// ---------------------------------------------------------------------------

function onMyBoardClick(x, y) {
  if (S.phase !== 'placing' || S.myReady) return;
  const existing = shipAt(x, y);
  if (existing) {
    // Levanta el barco para volver a ubicarlo.
    S.ships = S.ships.filter((s) => s !== existing);
    S.selected = FLEET.findIndex((f) => f.id === existing.id);
    S.horizontal = existing.cells[0].y === existing.cells[existing.size - 1].y;
    S.hover = { x, y };
    render();
    return;
  }
  if (S.selected < 0) return;
  const f = FLEET[S.selected];
  const cells = placementFor(x, y, f.size, S.horizontal);
  if (!canPlace(cells)) return;
  S.ships.push({ ...f, cells, hits: 0 });
  S.selected = nextUnplaced();
  render();
}

function rotate() {
  if (S.phase !== 'placing' || S.myReady) return;
  S.horizontal = !S.horizontal;
  render();
}

els.btnRotate.addEventListener('click', rotate);
els.btnRandom.addEventListener('click', () => {
  if (S.myReady) return;
  S.ships = randomFleet();
  S.selected = -1;
  render();
});
els.btnClear.addEventListener('click', () => {
  if (S.myReady) return;
  S.ships = [];
  S.selected = 0;
  render();
});
els.btnReady.addEventListener('click', () => {
  if (!allPlaced() || S.myReady || S.phase !== 'placing') return;
  S.myReady = true;
  send({ type: 'ready' });
  addChat(null, 'Tu flota está lista.');
  maybeStart();
  render();
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'r' || e.key === 'R') && !(e.target instanceof HTMLInputElement)) rotate();
});

// ---------------------------------------------------------------------------
// Juego
// ---------------------------------------------------------------------------

function resetRound() {
  S.ships = [];
  S.horizontal = true;
  S.selected = 0;
  S.hover = null;
  S.incoming.clear();
  S.outgoing.clear();
  S.revealed.clear();
  S.enemySunk = [];
  S.myReady = false;
  S.enemyReady = false;
  S.myTurn = false;
  S.pendingShot = null;
  S.lastEvent = '';
  S.rematchMe = false;
  S.rematchEnemy = false;
  S.phase = 'placing';
  hideOverlay();
  render();
}

// El anfitrión decide quién arranca cuando ambos están listos.
function maybeStart() {
  if (S.role !== 'host' || !S.myReady || !S.enemyReady || S.phase !== 'placing') return;
  const first = Math.random() < 0.5 ? 'host' : 'guest';
  send({ type: 'start', first });
  startBattle(first === 'host');
}

function startBattle(iStart) {
  S.phase = 'playing';
  S.myTurn = iStart;
  S.lastEvent = '';
  addChat(null, `¡Empieza la batalla! Arranca ${iStart ? 'vos' : S.enemyName}.`);
  render();
}

function shoot(x, y) {
  if (S.phase !== 'playing' || !S.myTurn || S.pendingShot || S.outgoing.has(key(x, y))) return;
  S.pendingShot = { x, y };
  send({ type: 'shot', x, y });
  render();
}

function handleShot(msg) {
  const { x, y } = msg;
  if (S.phase !== 'playing' || S.myTurn || !validCoord(x, y) || S.incoming.has(key(x, y))) return;
  const ship = shipAt(x, y);
  let sunk = null;
  if (ship) {
    ship.hits++;
    S.incoming.set(key(x, y), 'hit');
    if (ship.hits === ship.size) sunk = { name: ship.name, cells: ship.cells };
  } else {
    S.incoming.set(key(x, y), 'miss');
  }
  const over = S.ships.every((s) => s.hits === s.size);
  send({ type: 'result', x, y, hit: !!ship, sunk, over });

  const where = coordName(x, y);
  if (sunk) S.lastEvent = `💥 ${S.enemyName} hundió tu ${sunk.name.toLowerCase()} (${where}).`;
  else if (ship) S.lastEvent = `🔥 ${S.enemyName} te tocó en ${where}.`;
  else S.lastEvent = `💦 ${S.enemyName} tiró al agua en ${where}.`;

  if (over) {
    endGame(false);
  } else {
    S.myTurn = true;
    render();
  }
  boom(myCells[y][x]);
}

function handleResult(msg) {
  const p = S.pendingShot;
  if (S.phase !== 'playing' || !p || p.x !== msg.x || p.y !== msg.y) return;
  S.pendingShot = null;
  const { x, y } = p;
  S.outgoing.set(key(x, y), msg.hit ? 'hit' : 'miss');
  const where = coordName(x, y);
  if (msg.sunk && Array.isArray(msg.sunk.cells)) {
    for (const c of msg.sunk.cells) {
      if (validCoord(c.x, c.y)) S.outgoing.set(key(c.x, c.y), 'sunk');
    }
    const name = cleanName(msg.sunk.name);
    S.enemySunk.push(name);
    S.lastEvent = `💥 ¡Hundiste el ${name.toLowerCase()}!`;
  } else if (msg.hit) {
    S.lastEvent = `🔥 ¡Tocado en ${where}!`;
  } else {
    S.lastEvent = `💦 Agua en ${where}.`;
  }

  if (msg.over) {
    send({ type: 'reveal', ships: S.ships.map((s) => s.cells) });
    endGame(true);
  } else {
    S.myTurn = false;
    render();
  }
  boom(enemyCells[y][x]);
}

function handleReveal(msg) {
  if (S.phase !== 'over' || !Array.isArray(msg.ships)) return;
  for (const cells of msg.ships) {
    if (!Array.isArray(cells)) continue;
    for (const c of cells) {
      if (c && validCoord(c.x, c.y)) S.revealed.add(key(c.x, c.y));
    }
  }
  render();
}

function endGame(won) {
  S.phase = 'over';
  S.myTurn = false;
  S.lastEvent = won ? '🏆 ¡Ganaste! Hundiste toda la flota enemiga.' : `☠️ Perdiste. ${S.enemyName} hundió toda tu flota.`;
  addChat(null, won ? '¡Ganaste la partida!' : `${S.enemyName} ganó la partida.`);
  render();
  showOverlay(
    won ? '🏆 ¡Ganaste!' : '☠️ Perdiste',
    won ? `Hundiste toda la flota de ${S.enemyName}.` : `${S.enemyName} hundió toda tu flota.`,
    [
      { label: 'Revancha', primary: true, onClick: () => { hideOverlay(); askRematch(); } },
      { label: 'Ver tableros', onClick: hideOverlay },
    ],
  );
}

function askRematch() {
  if (S.phase !== 'over' || S.rematchMe) return;
  S.rematchMe = true;
  send({ type: 'rematch' });
  maybeRematch();
  render();
}

function maybeRematch() {
  if (S.phase !== 'over' || !S.rematchMe || !S.rematchEnemy) return;
  resetRound();
  addChat(null, '¡Revancha! Ubicá tus barcos.');
}

els.btnRematch.addEventListener('click', askRematch);
els.btnHome.addEventListener('click', leave);
els.btnLeave.addEventListener('click', () => {
  if (S.phase === 'playing' && !confirm('¿Seguro que querés abandonar la partida?')) return;
  leave();
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function addChat(author, text, mine = false) {
  const p = document.createElement('p');
  if (author === null) {
    p.className = 'sys';
    p.textContent = text;
  } else {
    p.className = mine ? 'me' : 'them';
    const b = document.createElement('b');
    b.textContent = `${author}: `;
    p.append(b, document.createTextNode(text));
  }
  els.chatLog.append(p);
  els.chatLog.scrollTop = els.chatLog.scrollHeight;
}

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim().slice(0, 200);
  if (!text || !S.code) return;
  send({ type: 'chat', text });
  addChat(S.myName, text, true);
  els.chatInput.value = '';
});

// ---------------------------------------------------------------------------
// Red: WebSocket con la sala de la partida (src/worker.js)
// ---------------------------------------------------------------------------
// Cada mensaje propio va numerado y queda en `outbox` hasta que la sala lo
// confirma; si se corta la conexión se reenvía al reconectar. La sala guarda los
// mensajes del rival y, al reconectar, manda los que nos perdimos.

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function send(data) {
  if (!S.code) return;
  const seq = ++S.outSeq;
  S.outbox.push({ seq, data });
  if (socketOpen()) S.ws.send(JSON.stringify({ t: 'msg', seq, data }));
}

function socketOpen() {
  return S.wsReady && S.ws.readyState === WebSocket.OPEN;
}

function connect() {
  clearTimeout(S.retryTimer);
  if (!S.code || S.ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ role: S.role, token: S.token, since: S.inSeq });
  const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${S.code}/ws?${params}`);
  S.ws = ws;
  S.wsReady = false;
  ws.onmessage = (e) => {
    if (S.ws === ws) onSocketMessage(ws, e.data);
  };
  ws.onclose = () => {
    if (S.ws === ws) onSocketLost();
  };
}

function onSocketMessage(ws, raw) {
  if (raw === 'pong') {
    clearTimeout(S.pongTimer);
    return;
  }
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  switch (m.t) {
    case 'welcome':
      S.wsReady = true;
      S.failures = 0;
      S.outbox = S.outbox.filter((o) => o.seq > m.lastSeq);
      for (const o of S.outbox) ws.send(JSON.stringify({ t: 'msg', seq: o.seq, data: o.data }));
      startPing();
      onWelcome(m.peerPresent);
      break;
    case 'ack':
      S.outbox = S.outbox.filter((o) => o.seq > m.seq);
      break;
    case 'peer':
      onPeerPresence(m.present);
      break;
    case 'msg':
      if (!Number.isInteger(m.seq) || m.seq <= S.inSeq) return;
      S.inSeq = m.seq;
      onData(m.data);
      break;
    case 'error':
      onRoomError(m.error);
      break;
  }
}

// Se cortó (o se colgó) la conexión: reintenta con espera creciente.
function onSocketLost() {
  const ws = S.ws;
  S.ws = null;
  S.wsReady = false;
  stopPing();
  try { ws?.close(); } catch { /* ya cerrada */ }
  if (!S.code) return;
  if (S.phase === 'creating' || S.phase === 'joining') {
    if (++S.failures >= MAX_INITIAL_FAILURES) {
      failToLobby('No se pudo conectar con el servidor. Revisá tu internet y probá de nuevo.');
      return;
    }
  } else {
    S.failures++;
  }
  const delay = Math.min(500 * 2 ** S.failures, MAX_RETRY_MS);
  S.retryTimer = setTimeout(connect, delay);
  renderNet();
}

function startPing() {
  stopPing();
  S.pingTimer = setInterval(checkAlive, PING_EVERY_MS);
}

function stopPing() {
  clearInterval(S.pingTimer);
  clearTimeout(S.pongTimer);
}

// En el celular una conexión puede quedar "colgada" sin cerrarse: si no responde, se descarta.
function checkAlive() {
  if (!socketOpen()) return;
  clearTimeout(S.pongTimer);
  S.ws.send('ping');
  S.pongTimer = setTimeout(onSocketLost, PONG_TIMEOUT_MS);
}

// Al volver a la pestaña o recuperar internet, reconecta (o verifica la conexión) en el acto.
function wakeUp() {
  if (!S.code) return;
  if (!S.ws) connect();
  else checkAlive();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') wakeUp();
});
window.addEventListener('online', wakeUp);

function onWelcome(peerPresent) {
  if (S.phase === 'creating') {
    S.phase = 'waiting';
    els.codeDisplay.textContent = S.code;
    lobbyMsg('');
    setLobbyBusy(false);
    showScreen('waiting');
  } else if (S.phase === 'joining') {
    enterGame();
  }
  onPeerPresence(peerPresent, true);
}

function onPeerPresence(present, quiet = false) {
  const changed = present !== S.peerOnline;
  S.peerOnline = present;
  if (present && S.phase === 'waiting') {
    enterGame();
    return;
  }
  if (changed && !quiet && ['placing', 'playing', 'over'].includes(S.phase)) {
    addChat(null, present ? `${S.enemyName} volvió.` : `${S.enemyName} se desconectó. Esperando que vuelva…`);
  }
  renderNet();
}

function onRoomError(error) {
  if (error === 'taken' && S.phase === 'creating') {
    // Ese código ya está en uso: prueba con otro.
    createGame();
    return;
  }
  failToLobby({
    'not-found': 'No existe ninguna partida con ese código. Revisalo y probá de nuevo.',
    full: 'Esa partida ya tiene dos jugadores.',
  }[error] || 'No se pudo entrar a la partida.');
}

function renderNet() {
  els.waitingNote.textContent = S.wsReady ? 'Esperando que se una…' : 'Reconectando…';
  let text = '';
  if (['placing', 'playing', 'over'].includes(S.phase)) {
    if (!S.wsReady) text = '📡 Sin conexión. Reconectando…';
    else if (!S.peerOnline && !S.heardFromEnemy) text = '⏳ Tu amigo todavía no volvió a la partida. Podés ir ubicando tus barcos.';
    else if (!S.peerOnline) text = `⚠️ Se cortó la conexión de ${S.enemyName}. Cuando vuelva, la partida sigue donde estaba.`;
  }
  els.netBanner.textContent = text;
  els.netBanner.hidden = !text;
}

function myName() {
  const name = els.name.value.replace(/\s+/g, ' ').trim().slice(0, 20);
  storageSet('bn-name', name);
  return name || 'Capitán';
}

function startSession(role, code, phase) {
  teardown();
  S.role = role;
  S.code = code;
  S.token = randomToken();
  S.phase = phase;
  S.myName = myName();
  setLobbyBusy(true);
  connect();
}

function createGame() {
  lobbyMsg('Creando partida…');
  startSession('host', randomCode(), 'creating');
}

function joinGame(raw) {
  const code = normalizeCode(raw);
  if (code.length !== CODE_LENGTH) {
    lobbyMsg(`El código tiene ${CODE_LENGTH} caracteres.`, true);
    return;
  }
  lobbyMsg('Conectando…');
  startSession('guest', code, 'joining');
}

function enterGame() {
  setLobbyBusy(false);
  lobbyMsg('');
  els.chatLog.replaceChildren();
  showScreen('game');
  resetRound();
  send({ type: 'hello', name: S.myName });
  addChat(null, S.role === 'guest' && !S.peerOnline
    ? 'Entraste a la partida. Ubicá tus barcos mientras vuelve tu amigo.'
    : 'Conectado. Ubicá tus barcos.');
  renderNet();
}

function onData(msg) {
  if (!msg || typeof msg !== 'object') return;
  // El rival entró mientras no estábamos conectados.
  if (S.phase === 'waiting') enterGame();
  switch (msg.type) {
    case 'hello':
      S.enemyName = cleanName(msg.name);
      S.heardFromEnemy = true;
      addChat(null, `Jugás contra ${S.enemyName}.`);
      render();
      renderNet();
      break;
    case 'ready':
      if (S.phase !== 'placing') return;
      S.enemyReady = true;
      addChat(null, `${S.enemyName} tiene su flota lista.`);
      maybeStart();
      render();
      break;
    case 'start':
      if (S.role === 'guest' && S.phase === 'placing') startBattle(msg.first === 'guest');
      break;
    case 'shot':
      handleShot(msg);
      break;
    case 'result':
      handleResult(msg);
      break;
    case 'reveal':
      handleReveal(msg);
      break;
    case 'chat':
      if (typeof msg.text === 'string' && msg.text.trim()) addChat(S.enemyName, msg.text.trim().slice(0, 200));
      break;
    case 'rematch':
      if (S.phase !== 'over') return;
      S.rematchEnemy = true;
      addChat(null, `${S.enemyName} quiere la revancha.`);
      maybeRematch();
      render();
      break;
    case 'bye':
      onPeerLeft();
      break;
  }
}

function onPeerLeft() {
  if (!['placing', 'playing', 'over'].includes(S.phase)) return;
  const wasOver = S.phase === 'over';
  const enemy = S.enemyName;
  S.phase = 'closed';
  teardown({ keepState: true });
  addChat(null, `${enemy} salió de la partida.`);
  showOverlay(
    `${enemy} salió`,
    wasOver ? `${enemy} dejó la partida.` : `${enemy} abandonó la partida, así que no puede continuar.`,
    [{ label: 'Volver al inicio', primary: true, onClick: leave }],
  );
}

function teardown({ keepState = false } = {}) {
  clearTimeout(S.retryTimer);
  stopPing();
  const ws = S.ws;
  S.ws = null;
  S.wsReady = false;
  S.code = null;
  try { ws?.close(); } catch { /* ya cerrada */ }
  S.token = null;
  S.outSeq = 0;
  S.outbox = [];
  S.inSeq = 0;
  S.peerOnline = false;
  S.failures = 0;
  if (keepState) return;
  S.heardFromEnemy = false;
  S.role = null;
  S.enemyName = 'Rival';
  S.phase = 'lobby';
}

function failToLobby(message) {
  teardown();
  setLobbyBusy(false);
  hideOverlay();
  showScreen('lobby');
  lobbyMsg(message, true);
}

function leave() {
  // Avisa al rival y le da un instante al mensaje para salir antes de cerrar.
  if (socketOpen()) {
    send({ type: 'bye' });
    const ws = S.ws;
    S.ws = null;
    setTimeout(() => { try { ws.close(); } catch { /* ya cerrada */ } }, 300);
  }
  teardown();
  hideOverlay();
  setLobbyBusy(false);
  lobbyMsg('');
  history.replaceState(null, '', location.pathname);
  showScreen('lobby');
  updateTitle();
}

// Al cerrar la pestaña (no al cambiar de app) se avisa al rival que no vamos a volver.
window.addEventListener('pagehide', (e) => {
  if (!e.persisted && socketOpen()) send({ type: 'bye' });
});

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------

function inviteLink() {
  return `${location.origin}${location.pathname}?c=${S.code}`;
}

els.btnCreate.addEventListener('click', () => createGame());
els.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  joinGame(els.joinCode.value);
});
els.joinCode.addEventListener('input', () => {
  els.joinCode.value = normalizeCode(els.joinCode.value);
});
els.btnCancel.addEventListener('click', leave);
els.btnLobbyCancel.addEventListener('click', leave);

els.btnCopy.addEventListener('click', async () => {
  const link = inviteLink();
  try {
    await navigator.clipboard.writeText(link);
    els.btnCopy.textContent = '¡Copiado!';
    setTimeout(() => { els.btnCopy.textContent = 'Copiar link'; }, 1500);
  } catch {
    prompt('Copiá este link:', link);
  }
});

if (navigator.share) {
  els.btnShare.hidden = false;
  els.btnShare.addEventListener('click', () => {
    navigator.share({
      title: 'Batalla Naval',
      text: `¡Jugá a la batalla naval conmigo! Código: ${S.code}`,
      url: inviteLink(),
    }).catch(() => { /* cancelado */ });
  });
}

els.name.value = storageGet('bn-name') || '';

const invitedCode = normalizeCode(new URLSearchParams(location.search).get('c'));
if (invitedCode.length === CODE_LENGTH) {
  els.joinCode.value = invitedCode;
  lobbyMsg('¡Te invitaron a una partida! Poné tu nombre y tocá «Unirse».');
  els.btnJoin.classList.add('primary');
  (els.name.value ? els.btnJoin : els.name).focus();
}
