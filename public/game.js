'use strict';

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const SIZE = 10;
const LETTERS = 'ABCDEFGHIJ';
// Tiene que coincidir con src/rules.js.
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
// Intentos fallidos antes de rendirse al crear o unirse a una partida nueva.
const MAX_INITIAL_FAILURES = 4;
const HOME_REFRESH_MS = 30000;

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

function randomToken() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
}

function storageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

function storageSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ }
}

function b64urlEncode(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function postJson(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Mis partidas (guardadas en este navegador)
// ---------------------------------------------------------------------------
// Cada partida: { code, role: 'host' | 'guest', token, enemyName, addedAt }.
// El token es lo que identifica al jugador ante el servidor.

function loadGames() {
  try {
    const list = JSON.parse(storageGet('bn-games') || '[]');
    return Array.isArray(list) ? list.filter((g) => g && g.code && g.token && g.role) : [];
  } catch {
    return [];
  }
}

function saveGames(list) {
  storageSet('bn-games', JSON.stringify(list));
}

function findGame(code) {
  return loadGames().find((g) => g.code === code) || null;
}

function upsertGame(entry) {
  const list = loadGames();
  const i = list.findIndex((g) => g.code === entry.code);
  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.push({ addedAt: Date.now(), ...entry });
  saveGames(list);
}

function removeGame(code) {
  saveGames(loadGames().filter((g) => g.code !== code));
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

const S = {
  // Conexión con la sala de la partida abierta (ver src/worker.js)
  ws: null,
  wsReady: false,
  failures: 0,
  retryTimer: null,
  pingTimer: null,
  pongTimer: null,
  code: null,
  role: null, // 'host' | 'guest'
  token: null,
  create: false, // la conexión crea la partida
  isNew: false, // partida que todavía no está en la lista (creando o uniéndose)
  view: null, // último estado de la partida que mandó el servidor
  // Ubicación de barcos (antes de «¡Listo!» la flota sólo existe acá)
  ships: [], // { id, name, size, cells: [{x, y}], hits }
  horizontal: true,
  selected: 0, // índice en FLEET del barco a ubicar, -1 si no hay
  hover: null, // casilla bajo el mouse (sólo con mouse) para previsualizar el próximo barco
  active: null, // id del barco ya puesto que está marcado (el último puesto, girado o movido)
  drag: null, // barco que se está arrastrando: { id, grab, start, cells, ok }
  flash: null, // { cells, msg } cuando algo no entra, se borra solo
  sendingFleet: false,
  pendingShot: null,
  lastEvent: '',
  lastChatId: 0,
  askName: false, // llegó por link sin nombre guardado: se pregunta antes de unirse
  unread: 0, // mensajes del rival sin leer con el chat cerrado (celular)
  pushOn: false, // este navegador tiene los avisos activados
};

// ---------------------------------------------------------------------------
// Elementos
// ---------------------------------------------------------------------------

const els = {
  screens: { lobby: $('#lobby'), game: $('#game') },
  name: $('#name'),
  btnCreate: $('#btn-create'),
  joinForm: $('#join-form'),
  joinCode: $('#join-code'),
  btnJoin: $('#btn-join'),
  lobbyMsg: $('#lobby-msg'),
  gamesList: $('#games-list'),
  gamesEmpty: $('#games-empty'),
  pushText: $('#push-text'),
  btnPush: $('#btn-push'),
  btnPushOff: $('#btn-push-off'),
  pushActions: $('#push-actions'),
  btnTransfer: $('#btn-transfer'),
  invite: $('#invite'),
  inviteCode: $('#invite-code'),
  btnCopy: $('#btn-copy'),
  btnShare: $('#btn-share'),
  pushOffer: $('#push-offer'),
  btnPushOffer: $('#btn-push-offer'),
  btnPushDismiss: $('#btn-push-dismiss'),
  btnName: $('#btn-name'),
  enemyName: $('#enemy-name'),
  peerDot: $('#peer-dot'),
  chatToast: $('#chat-toast'),
  nameDialog: $('#name-dialog'),
  nameForm: $('#name-form'),
  nameEdit: $('#name-edit'),
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
  myWrap: $('#my-wrap'),
  btnMini: $('#btn-mini'),
  scrim: $('#scrim'),
  chat: $('#chat'),
  btnChat: $('#btn-chat'),
  btnChatClose: $('#btn-chat-close'),
  chatBadge: $('#chat-badge'),
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
// Lo que dice el servidor
// ---------------------------------------------------------------------------

const V = () => S.view;
const phase = () => S.view?.phase ?? 'connecting';
const enemy = () => S.view?.enemyName || 'Tu rival';
const myTurn = () => !!S.view?.myTurn;

// La flota que se muestra: la del servidor una vez confirmada, si no la que estás armando.
function shownShips() {
  return S.view?.myReady ? S.view.myShips || [] : S.ships;
}

function shotMap(list) {
  const m = new Map();
  for (const s of list || []) m.set(key(s.x, s.y), s.r);
  return m;
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

// La flota a medio armar se guarda por si se cierra el juego antes de «¡Listo!».
function saveDraft() {
  if (!S.view) return;
  storageSet('bn-draft', JSON.stringify({ code: S.code, round: S.view.round, ships: S.ships }));
}

function loadDraft() {
  try {
    const d = JSON.parse(storageGet('bn-draft') || 'null');
    if (d && d.code === S.code && d.round === S.view?.round && Array.isArray(d.ships)) {
      return d.ships.filter((s) => FLEET.some((f) => f.id === s.id) && Array.isArray(s.cells));
    }
  } catch { /* borrador roto */ }
  return [];
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

// Ubicación con mouse o dedo: tocar una casilla vacía pone el próximo barco,
// tocar un barco puesto lo gira, y arrastrarlo lo mueve.
let suppressClick = false;

function cellFromPoint(e) {
  const b = document.elementFromPoint(e.clientX, e.clientY)?.closest('#my-board .cell');
  return b ? { x: Number(b.dataset.x), y: Number(b.dataset.y) } : null;
}

function canEditFleet() {
  return phase() === 'placing' && !S.view.myReady && !S.sendingFleet;
}

els.myBoard.addEventListener('pointerdown', (e) => {
  if (!canEditFleet() || e.button > 0) return;
  const c = cellFromPoint(e);
  const ship = c && shipAt(c.x, c.y);
  if (!ship) return;
  const grab = ship.cells.findIndex((p) => p.x === c.x && p.y === c.y);
  S.drag = { id: ship.id, grab, start: c, at: c, cells: ship.cells, ok: true };
  els.myBoard.setPointerCapture(e.pointerId);
});

els.myBoard.addEventListener('pointermove', (e) => {
  if (!canEditFleet()) return;
  if (!S.drag) {
    if (e.pointerType !== 'mouse') return;
    const c = cellFromPoint(e);
    if (c?.x !== S.hover?.x || c?.y !== S.hover?.y) {
      S.hover = c;
      renderMyBoard();
    }
    return;
  }
  const c = cellFromPoint(e);
  if (!c || (c.x === S.drag.at.x && c.y === S.drag.at.y)) return;
  const ship = S.ships.find((s) => s.id === S.drag.id);
  const horizontal = isHorizontal(ship);
  const ox = horizontal ? c.x - S.drag.grab : c.x;
  const oy = horizontal ? c.y : c.y - S.drag.grab;
  const cells = shipCells(
    Math.max(0, Math.min(ox, horizontal ? SIZE - ship.size : SIZE - 1)),
    Math.max(0, Math.min(oy, horizontal ? SIZE - 1 : SIZE - ship.size)),
    ship.size, horizontal,
  );
  S.drag.at = c;
  S.drag.cells = cells;
  S.drag.ok = canPlace(cells, otherShips(ship));
  renderMyBoard();
});

els.myBoard.addEventListener('pointerup', (e) => {
  if (!canEditFleet()) return;
  suppressClick = true;
  setTimeout(() => { suppressClick = false; });
  const drag = S.drag;
  S.drag = null;
  clearFlash();
  if (drag) {
    const ship = S.ships.find((s) => s.id === drag.id);
    const moved = drag.at.x !== drag.start.x || drag.at.y !== drag.start.y;
    if (!moved) {
      rotateShip(ship, drag.start);
    } else if (drag.ok) {
      ship.cells = drag.cells;
      S.active = ship.id;
      render();
    } else {
      flash(drag.cells, 'Ahí no entra: se pisa con otro barco.');
    }
    return;
  }
  const c = cellFromPoint(e);
  if (c) placeNext(c.x, c.y);
});

els.myBoard.addEventListener('pointercancel', () => {
  S.drag = null;
  renderMyBoard();
});

els.myBoard.addEventListener('pointerleave', (e) => {
  if (e.pointerType !== 'mouse' || !S.hover) return;
  S.hover = null;
  renderMyBoard();
});

function isHorizontal(ship) {
  return ship.size === 1 || ship.cells[0].y === ship.cells[1].y;
}

function otherShips(ship) {
  return S.ships.filter((s) => s !== ship);
}

let flashTimer = 0;
function clearFlash() {
  clearTimeout(flashTimer);
  S.flash = null;
}

function flash(cells, msg) {
  clearFlash();
  S.flash = { cells, msg };
  render();
  flashTimer = setTimeout(() => {
    S.flash = null;
    render();
  }, 1800);
}

function previewCells() {
  if (!canEditFleet() || S.drag || !S.hover || S.selected < 0) return null;
  const f = FLEET[S.selected];
  if (shipAt(S.hover.x, S.hover.y)) return null;
  const cells = placementFor(S.hover.x, S.hover.y, f.size, S.horizontal);
  return { cells, ok: canPlace(cells) };
}

function renderMyBoard() {
  const placing = !!S.view && canEditFleet();
  const ships = shownShips();
  const incoming = shotMap(S.view?.incoming);
  let preview = previewCells();
  if (S.drag && (S.drag.at.x !== S.drag.start.x || S.drag.at.y !== S.drag.start.y)) {
    preview = { cells: S.drag.cells, ok: S.drag.ok };
  }
  if (S.flash) preview = { cells: S.flash.cells, ok: false };
  const previewKeys = new Set(preview ? preview.cells.map((c) => key(c.x, c.y)) : []);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const k = key(x, y);
      const cls = ['cell'];
      const ship = shipAt(x, y, ships);
      const sunk = ship && ship.hits === ship.size;
      if (ship) {
        cls.push('ship', ship.cells[0].y === ship.cells[ship.size - 1].y ? 'h' : 'v');
        const i = ship.cells.findIndex((c) => c.x === x && c.y === y);
        if (i === 0) cls.push('bow');
        if (i === ship.size - 1) cls.push('stern');
        if (sunk) cls.push('sunk');
        if (placing && ship.id === S.active) cls.push('active');
        if (placing && preview && S.drag?.id === ship.id) cls.push('lifted');
      }
      const shot = incoming.get(k);
      if (shot === 'hit' && !sunk) cls.push('hit');
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
  const v = V();
  const canShoot = phase() === 'playing' && myTurn() && !S.pendingShot && S.wsReady;
  const outgoing = shotMap(v?.outgoing);
  for (const s of v?.sunk || []) {
    for (const c of s.cells) outgoing.set(key(c.x, c.y), 'sunk');
  }
  const revealed = new Set();
  for (const cells of v?.reveal || []) {
    for (const c of cells) revealed.add(key(c.x, c.y));
  }
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const k = key(x, y);
      const cls = ['cell'];
      const shot = outgoing.get(k);
      if (shot) cls.push(shot);
      else if (revealed.has(k)) cls.push('reveal');
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
      if (!canEditFleet()) return;
      // Un barco puesto queda marcado (para girarlo con el botón); uno sin poner pasa a ser el próximo.
      if (placed) S.active = f.id;
      else {
        S.selected = i;
        S.active = null;
      }
      render();
    });
    return li;
  }));
}

function renderEnemyFleet() {
  const sunk = (V()?.sunk || []).map((s) => s.name);
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
  const v = V();
  if (!v) return S.askName ? 'Elegí tu nombre para entrar a la partida.' : 'Conectando…';
  const rival = enemy();
  switch (v.phase) {
    case 'placing': {
      if (v.myReady) {
        if (!v.enemyJoined) return 'Flota lista. Cuando tu amigo entre y ubique la suya, empieza la batalla.';
        return `Flota lista. Esperando a que ${rival} ubique sus barcos…`;
      }
      if (S.sendingFleet) return 'Mandando tu flota…';
      if (S.flash) return S.flash.msg;
      const waiting = v.enemyReady ? ` ${rival} ya está esperando.` : '';
      const edit = S.ships.length ? ' Tocá un barco para girarlo o arrastralo para moverlo.' : '';
      if (allPlaced()) return `¡Flota ubicada! Tocá «¡Listo!» para empezar.${edit}${waiting}`;
      const f = FLEET[S.selected];
      const dir = S.horizontal ? 'acostado →' : 'parado ↓';
      return `Tocá el tablero para poner el ${f.name.toLowerCase()} (${f.size} casillas, ${dir}).${edit}${waiting}`;
    }
    case 'playing': {
      const turn = v.myTurn ? '🎯 Tu turno: elegí dónde disparar.' : `⏳ Turno de ${rival}…`;
      return S.lastEvent ? `${S.lastEvent} ${turn}` : turn;
    }
    case 'over': {
      let result;
      if (v.winner === 'me') {
        result = v.endReason === 'abandon' ? `🏆 Ganaste: ${rival} abandonó la partida.` : '🏆 ¡Ganaste! Hundiste toda la flota enemiga.';
      } else {
        result = v.endReason === 'abandon' ? 'Abandonaste la partida.' : `☠️ Perdiste. ${rival} hundió toda tu flota.`;
      }
      if (v.enemyLeft) return v.endReason === 'abandon' ? result : `${result} ${rival} dejó la partida.`;
      if (v.rematch.me) return `${result} Esperando que ${rival} acepte la revancha…`;
      if (v.rematch.enemy) return `${result} ${rival} quiere la revancha. ¿Jugamos otra?`;
      return result;
    }
    default:
      return '';
  }
}

function render() {
  if (els.screens.game.hidden) return;
  const v = V();
  const ph = phase();
  els.btnName.textContent = v?.myName || els.name.value.trim() || 'Capitán';
  els.enemyName.textContent = v?.enemyJoined ? v.enemyName : 'esperando rival';
  els.peerDot.hidden = !v?.peerOnline;
  els.gameCode.textContent = S.code || '';
  els.status.textContent = statusText();
  els.status.classList.toggle('my-turn', ph === 'playing' && myTurn());

  const placing = ph === 'placing';
  els.invite.hidden = !v || v.enemyJoined;
  els.inviteCode.textContent = S.code || '';
  els.placement.hidden = !placing || v.myReady;
  els.btnReady.disabled = !allPlaced() || S.sendingFleet || !S.wsReady;
  els.endActions.hidden = ph !== 'over';
  els.btnRematch.hidden = !v || v.enemyLeft || (v.endReason === 'abandon' && v.winner !== 'me');
  els.btnRematch.disabled = !!v?.rematch.me;
  els.btnRematch.textContent = v?.rematch.enemy ? 'Aceptar revancha' : 'Revancha';
  els.enemyWrap.classList.toggle('inactive', ph !== 'playing' && ph !== 'over');
  els.boards.classList.toggle('playing', ph === 'playing');
  const battle = ph === 'playing' || ph === 'over';
  els.screens.game.classList.toggle('battle', battle);
  els.screens.game.classList.toggle('their-turn', ph === 'playing' && !myTurn());
  if (!battle) zoomMyBoard(false);
  els.chatInput.disabled = !v;

  if (canEditFleet()) saveDraft();
  renderShipList();
  renderMyBoard();
  renderEnemyBoard();
  renderEnemyFleet();
  renderNet();
  renderPushOffer();
  updateTitle();
}

function updateTitle() {
  const mine = !els.screens.game.hidden && phase() === 'playing' && myTurn();
  document.title = mine && document.hidden ? '🎯 ¡Tu turno! · Batalla Naval' : 'Batalla Naval';
}
document.addEventListener('visibilitychange', updateTitle);

function renderNet() {
  let text = '';
  if (S.code && !S.wsReady && (S.view || S.failures > 0)) text = '📡 Sin conexión. Reconectando…';
  els.netBanner.textContent = text;
  els.netBanner.hidden = !text;
}

// En el celular, durante la batalla tu flota es un mini-radar (ver style.css).
// Para mostrarla en grande se la escala hasta el centro de la pantalla.
const mobile = matchMedia('(max-width: 899px)');

function zoomMyBoard(on) {
  const wrap = els.myWrap;
  if (on && !(mobile.matches && els.screens.game.classList.contains('battle'))) on = false;
  if (on && !wrap.classList.contains('zoom')) {
    const r = wrap.getBoundingClientRect();
    const scale = Math.min((innerWidth - 32) / r.width, (innerHeight * 0.75) / r.height);
    const dx = (innerWidth - r.width * scale) / 2 - r.left;
    const dy = (innerHeight - r.height * scale) / 2 - r.top;
    wrap.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`;
  } else if (!on) {
    wrap.style.transform = '';
  }
  wrap.classList.toggle('zoom', on);
  els.scrim.classList.toggle('on', on);
  els.btnMini.setAttribute('aria-label', on ? 'Achicar tu flota' : 'Ver tu flota en grande');
}

// Aviso sin mover nada cuando el rival te dispara: el radar destella (rojo si
// te tocó) y, si te tocó, el teléfono vibra.
function alertMyBoard(hit) {
  const wrap = els.myWrap;
  wrap.classList.remove('alert-hit', 'alert-miss');
  void wrap.offsetWidth;
  wrap.classList.add(hit ? 'alert-hit' : 'alert-miss');
  if (hit && mobile.matches) navigator.vibrate?.(120);
}

els.btnMini.addEventListener('click', () => zoomMyBoard(!els.myWrap.classList.contains('zoom')));
els.scrim.addEventListener('click', () => zoomMyBoard(false));
// En el celular la barra del navegador cambia el alto al hacer scroll: sólo
// importa si cambia el ancho (por ejemplo, al girar el teléfono).
let lastWidth = innerWidth;
addEventListener('resize', () => {
  if (innerWidth === lastWidth) return;
  lastWidth = innerWidth;
  zoomMyBoard(false);
});
mobile.addEventListener('change', () => zoomMyBoard(false));

function boom(cell) {
  cell.classList.remove('boom');
  void cell.offsetWidth;
  cell.classList.add('boom');
}

// ---------------------------------------------------------------------------
// Ubicación de barcos
// ---------------------------------------------------------------------------

// Teclado (Enter/Espacio sobre una casilla): mismo comportamiento que tocar.
function onMyBoardClick(x, y) {
  if (!canEditFleet() || suppressClick) return;
  clearFlash();
  const ship = shipAt(x, y);
  if (ship) rotateShip(ship, { x, y });
  else placeNext(x, y);
}

function placeNext(x, y) {
  if (!canEditFleet() || S.selected < 0 || shipAt(x, y)) return;
  const f = FLEET[S.selected];
  const cells = placementFor(x, y, f.size, S.horizontal);
  if (!canPlace(cells)) {
    flash(cells, `El ${f.name.toLowerCase()} no entra ahí. Probá en otro lugar o girá con «↻ Girar».`);
    return;
  }
  S.ships.push({ ...f, cells, hits: 0 });
  S.active = f.id;
  S.selected = nextUnplaced();
  S.hover = null;
  render();
}

// Gira un barco ya puesto alrededor de la casilla tocada. Si no entra así,
// prueba corriéndolo a lo largo de la nueva dirección.
function rotateShip(ship, pivot = ship.cells[0]) {
  const horizontal = !isHorizontal(ship);
  const at = Math.max(0, ship.cells.findIndex((c) => c.x === pivot.x && c.y === pivot.y));
  const order = [...Array(ship.size).keys()].sort((a, b) => Math.abs(a - at) - Math.abs(b - at));
  for (const i of order) {
    const cells = shipCells(horizontal ? pivot.x - i : pivot.x, horizontal ? pivot.y : pivot.y - i, ship.size, horizontal);
    if (canPlace(cells, otherShips(ship))) {
      ship.cells = cells;
      S.active = ship.id;
      S.horizontal = horizontal;
      render();
      return;
    }
  }
  S.active = ship.id;
  flash(placementFor(pivot.x, pivot.y, ship.size, horizontal), 'No hay lugar para girarlo ahí. Arrastralo a otro lado.');
}

// El botón gira el barco marcado; si no hay, cambia la dirección del próximo.
function rotate() {
  if (!canEditFleet()) return;
  clearFlash();
  const ship = S.ships.find((s) => s.id === S.active);
  if (ship) {
    rotateShip(ship, ship.cells[Math.floor((ship.size - 1) / 2)]);
    return;
  }
  S.horizontal = !S.horizontal;
  render();
}

els.btnRotate.addEventListener('click', rotate);
els.btnRandom.addEventListener('click', () => {
  if (!canEditFleet()) return;
  S.ships = randomFleet();
  S.selected = -1;
  S.active = null;
  clearFlash();
  render();
});
els.btnClear.addEventListener('click', () => {
  if (!canEditFleet()) return;
  S.ships = [];
  S.selected = 0;
  S.active = null;
  clearFlash();
  render();
});
els.btnReady.addEventListener('click', () => {
  if (!allPlaced() || !canEditFleet()) return;
  if (!send({ t: 'place', ships: S.ships.map((s) => ({ id: s.id, cells: s.cells })) })) return;
  S.sendingFleet = true;
  render();
});
document.addEventListener('keydown', (e) => {
  if ((e.key === 'r' || e.key === 'R') && !(e.target instanceof HTMLInputElement)) rotate();
});

// ---------------------------------------------------------------------------
// Juego
// ---------------------------------------------------------------------------

function resetPlacement() {
  S.ships = loadDraft();
  S.horizontal = true;
  S.selected = nextUnplaced();
  S.hover = null;
  S.active = null;
  S.drag = null;
  clearFlash();
}

function shoot(x, y) {
  if (phase() !== 'playing' || !myTurn() || S.pendingShot) return;
  if (S.view.outgoing.some((s) => s.x === x && s.y === y)) return;
  if (!send({ t: 'shoot', x, y })) return;
  S.pendingShot = { x, y };
  render();
}

// Texto del último disparo, para el estado (también al abrir la partida más tarde).
function describeShot(by, shot, sunkName) {
  const where = coordName(shot.x, shot.y);
  if (by === 'me') {
    if (sunkName) return `💥 ¡Hundiste el ${sunkName.toLowerCase()}!`;
    return shot.r === 'hit' ? `🔥 ¡Tocado en ${where}!` : `💦 Agua en ${where}.`;
  }
  const rival = enemy();
  if (sunkName) return `💥 ${rival} hundió tu ${sunkName.toLowerCase()} (${where}).`;
  return shot.r === 'hit' ? `🔥 ${rival} te tocó en ${where}.` : `💦 ${rival} tiró al agua en ${where}.`;
}

function lastShotSummary(v) {
  if (v.phase !== 'playing') return '';
  if (v.myTurn && v.incoming.length) {
    const shot = v.incoming[v.incoming.length - 1];
    const ship = shipAt(shot.x, shot.y, v.myShips || []);
    return describeShot('enemy', shot, ship && ship.hits === ship.size ? ship.name : null);
  }
  if (!v.myTurn && v.outgoing.length) {
    const shot = v.outgoing[v.outgoing.length - 1];
    const sunk = v.sunk.find((s) => s.cells.some((c) => c.x === shot.x && c.y === shot.y));
    return describeShot('me', shot, sunk?.name);
  }
  return '';
}

// Llega el estado de la partida desde el servidor.
function onState(view, event) {
  const prev = S.view;
  const first = !prev;
  S.view = view;
  S.pendingShot = null;
  S.sendingFleet = false;
  S.role = view.role;

  if (first) {
    if (S.isNew) {
      S.isNew = false;
      upsertGame({ code: S.code, role: S.role, token: S.token, enemyName: view.enemyName || '' });
    }
    history.replaceState(null, '', `${location.pathname}?c=${S.code}`);
    if (S.pushOn && !view.pushOn) syncPushForCurrent();
  }
  if (view.enemyName) upsertGame({ code: S.code, enemyName: view.enemyName });
  if (first || prev.round !== view.round) {
    resetPlacement();
    S.lastEvent = lastShotSummary(view);
  }
  renderChat(first);
  handleEvent(prev, event);
  render();

  const justEnded = prev && prev.phase !== 'over' && view.phase === 'over';
  if (justEnded) showEndOverlay();
}

function handleEvent(prev, event) {
  if (!event) return;
  const rival = enemy();
  const v = V();
  switch (event.kind) {
    case 'joined':
      addChat(null, `${rival} se unió a la partida.`);
      break;
    case 'name':
      if (event.by === 'enemy') addChat(null, `${event.old} ahora se llama ${event.name}.`);
      break;
    case 'ready':
      if (event.by === 'enemy') addChat(null, `${rival} tiene su flota lista.`);
      else addChat(null, 'Tu flota está lista.');
      break;
    case 'start':
      S.lastEvent = '';
      addChat(null, `¡Empieza la batalla! Arranca ${event.first === 'me' ? 'vos' : rival}.`);
      break;
    case 'shot': {
      const shot = { x: event.x, y: event.y, r: event.r };
      S.lastEvent = describeShot(event.by, shot, event.sunk);
      if (event.by === 'me') {
        boom(enemyCells[event.y][event.x]);
      } else {
        boom(myCells[event.y][event.x]);
        alertMyBoard(event.r === 'hit');
      }
      break;
    }
    case 'rematch':
      if (event.by === 'enemy') addChat(null, `${rival} quiere la revancha.`);
      break;
    case 'newround':
      S.lastEvent = '';
      addChat(null, '¡Revancha! Ubicá tus barcos.');
      break;
    case 'abandon':
      if (event.by === 'enemy') addChat(null, v.phase === 'over' && v.endReason !== 'abandon' ? `${rival} dejó la partida.` : `${rival} abandonó la partida.`);
      break;
  }
}

function showEndOverlay() {
  const v = V();
  const rival = enemy();
  const won = v.winner === 'me';
  let title = won ? '🏆 ¡Ganaste!' : '☠️ Perdiste';
  let text = won ? `Hundiste toda la flota de ${rival}.` : `${rival} hundió toda tu flota.`;
  if (v.endReason === 'abandon') {
    title = won ? '🏆 Ganaste' : 'Partida terminada';
    text = won ? `${rival} abandonó la partida.` : 'Abandonaste la partida.';
  }
  addChat(null, won ? '¡Ganaste la partida!' : `${rival} ganó la partida.`);
  const actions = [{ label: 'Ver tableros', onClick: hideOverlay }];
  if (!v.enemyLeft && v.endReason !== 'abandon') {
    actions.unshift({ label: 'Revancha', primary: true, onClick: () => { hideOverlay(); askRematch(); } });
  }
  showOverlay(title, text, actions);
}

function askRematch() {
  const v = V();
  if (!v || v.phase !== 'over' || v.rematch.me) return;
  send({ t: 'rematch' });
}

els.btnRematch.addEventListener('click', askRematch);
els.btnHome.addEventListener('click', goHome);
els.btnLeave.addEventListener('click', goHome);

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

function addChat(author, text, mine = false, quiet = false) {
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
  if (author !== null && !mine && !quiet && !els.chat.classList.contains('open')) {
    S.unread++;
    renderChatBadge();
    showChatToast(author, text);
  }
}

// Agrega los mensajes nuevos del historial que guarda el servidor.
function renderChat(initial) {
  const v = V();
  if (initial) {
    els.chatLog.replaceChildren();
    S.lastChatId = 0;
    S.unread = 0;
    renderChatBadge();
  }
  for (const m of v.chat) {
    if (m.id <= S.lastChatId) continue;
    S.lastChatId = m.id;
    addChat(m.mine ? v.myName : enemy(), m.text, m.mine, initial);
  }
  if (initial) {
    if (!v.enemyJoined) addChat(null, 'Mandale el link a tu amigo. Mientras tanto, ubicá tus barcos.');
    else if (v.chat.length === 0) addChat(null, `Jugás contra ${enemy()}.`);
  }
}

// En el celular, un aviso chiquito abajo con el mensaje; se va solo y al tocarlo abre el chat.
let toastTimer = 0;
function showChatToast(author, text) {
  if (!mobile.matches) return;
  const b = document.createElement('b');
  b.textContent = `${author}: `;
  els.chatToast.replaceChildren(b, document.createTextNode(text));
  els.chatToast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideChatToast, 3500);
}

function hideChatToast() {
  clearTimeout(toastTimer);
  els.chatToast.hidden = true;
}

els.chatToast.addEventListener('click', () => openChat(true));

// En el celular el chat es un panel que se abre con el botón de la barra de arriba.
function openChat(open) {
  els.chat.classList.toggle('open', open);
  els.btnChat.setAttribute('aria-expanded', String(open));
  if (open) {
    hideChatToast();
    S.unread = 0;
    renderChatBadge();
    els.chatLog.scrollTop = els.chatLog.scrollHeight;
  }
}

function renderChatBadge() {
  els.chatBadge.hidden = S.unread === 0;
  els.chatBadge.textContent = S.unread > 9 ? '9+' : String(S.unread);
}

els.btnChat.addEventListener('click', () => openChat(!els.chat.classList.contains('open')));
els.btnChatClose.addEventListener('click', () => openChat(false));

els.chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.chatInput.value.trim().slice(0, 200);
  if (!text || !send({ t: 'chat', text })) return;
  els.chatInput.value = '';
});

// ---------------------------------------------------------------------------
// Red: WebSocket con la sala de la partida abierta (src/worker.js)
// ---------------------------------------------------------------------------
// El servidor guarda la partida: cada jugada se manda y el servidor responde con
// el estado nuevo. Si se corta la conexión, al reconectar llega el estado completo.

function send(data) {
  if (!socketOpen()) {
    renderNet();
    return false;
  }
  S.ws.send(JSON.stringify(data));
  return true;
}

function socketOpen() {
  return S.wsReady && S.ws?.readyState === WebSocket.OPEN;
}

function connect() {
  clearTimeout(S.retryTimer);
  if (!S.code || S.ws) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const params = new URLSearchParams({ role: S.role, token: S.token });
  if (S.create) params.set('create', '1');
  if (S.isNew) params.set('name', myName());
  const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${S.code}/ws?${params}`);
  S.ws = ws;
  S.wsReady = false;
  ws.onmessage = (e) => {
    if (S.ws === ws) onSocketMessage(e.data);
  };
  ws.onclose = () => {
    if (S.ws === ws) onSocketLost();
  };
}

function onSocketMessage(raw) {
  if (raw === 'pong') {
    clearTimeout(S.pongTimer);
    return;
  }
  let m;
  try { m = JSON.parse(raw); } catch { return; }
  switch (m.t) {
    case 'state':
      if (!S.wsReady) {
        S.wsReady = true;
        S.failures = 0;
        startPing();
        // El servidor no manda avisos mientras tenés la partida a la vista.
        send({ t: 'visible', visible: !document.hidden });
      }
      onState(m.view, m.event);
      break;
    case 'peer':
      if (S.view) {
        S.view.peerOnline = m.present;
        render();
      }
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
  S.failures++;
  if (S.isNew && S.failures >= MAX_INITIAL_FAILURES) {
    failToLobby('No se pudo conectar con el servidor. Revisá tu internet y probá de nuevo.');
    return;
  }
  const delay = Math.min(500 * 2 ** S.failures, MAX_RETRY_MS);
  S.retryTimer = setTimeout(connect, delay);
  render();
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
  if (!els.screens.lobby.hidden) refreshGames();
  if (!S.code) return;
  if (!S.ws) connect();
  else checkAlive();
}
document.addEventListener('visibilitychange', () => {
  // El servidor no manda avisos mientras tenés la partida a la vista.
  if (socketOpen()) send({ t: 'visible', visible: !document.hidden });
  if (document.visibilityState === 'visible') wakeUp();
});
window.addEventListener('online', wakeUp);

function onRoomError(error) {
  if (error === 'taken' && S.create && S.isNew) {
    // Ese código ya está en uso: prueba con otro.
    createGame();
    return;
  }
  const code = S.code;
  const wasSaved = !S.isNew;
  if (error === 'not-found' && wasSaved) {
    removeGame(code);
    failToLobby('Esa partida ya no existe (se borran después de 30 días sin jugar).');
    return;
  }
  failToLobby({
    'not-found': 'No existe ninguna partida con ese código. Revisalo y probá de nuevo.',
    full: 'Esa partida ya tiene dos jugadores.',
    taken: 'No se pudo abrir la partida.',
  }[error] || 'No se pudo entrar a la partida.');
}

function teardown() {
  clearTimeout(S.retryTimer);
  stopPing();
  const ws = S.ws;
  S.ws = null;
  S.wsReady = false;
  try { ws?.close(); } catch { /* ya cerrada */ }
  S.code = null;
  S.role = null;
  S.token = null;
  S.create = false;
  S.isNew = false;
  S.view = null;
  S.failures = 0;
  S.pendingShot = null;
  S.sendingFleet = false;
  S.askName = false;
}

// ---------------------------------------------------------------------------
// Abrir, crear y unirse a partidas
// ---------------------------------------------------------------------------

function myName() {
  const name = els.name.value.replace(/\s+/g, ' ').trim().slice(0, 20);
  storageSet('bn-name', name);
  return name || 'Capitán';
}

function enterGameScreen() {
  hideOverlay();
  hideChatToast();
  openChat(false);
  els.chatLog.replaceChildren();
  S.unread = 0;
  renderChatBadge();
  S.lastEvent = '';
  resetPlacement();
  lobbyMsg('');
  showScreen('game');
  scrollTo(0, 0);
  render();
}

function startSession({ code, role, token, create = false, isNew = false }) {
  teardown();
  S.code = code;
  S.role = role;
  S.token = token;
  S.create = create;
  S.isNew = isNew;
  enterGameScreen();
}

function openGame(entry) {
  startSession(entry);
  connect();
}

function createGame() {
  startSession({ code: randomCode(), role: 'host', token: randomToken(), create: true, isNew: true });
  connect();
}

function joinGame(raw, { askName = false } = {}) {
  const code = normalizeCode(raw);
  if (code.length !== CODE_LENGTH) {
    lobbyMsg(`El código tiene ${CODE_LENGTH} caracteres.`, true);
    return;
  }
  const saved = findGame(code);
  if (saved) {
    openGame(saved);
    return;
  }
  startSession({ code, role: 'guest', token: randomToken(), isNew: true });
  if (askName) {
    // El rival te ve recién cuando elegís el nombre.
    S.askName = true;
    render();
    openNameDialog();
    return;
  }
  connect();
}

function goHome() {
  teardown();
  hideOverlay();
  els.nameDialog.hidden = true;
  hideChatToast();
  zoomMyBoard(false);
  history.replaceState(null, '', location.pathname);
  showScreen('lobby');
  updateTitle();
  refreshGames();
}

function failToLobby(message) {
  goHome();
  lobbyMsg(message, true);
}

// Cambiar el nombre (también en medio de la partida): se guarda y se le avisa al rival.
function openNameDialog() {
  els.nameEdit.value = els.name.value;
  els.nameDialog.hidden = false;
  els.nameEdit.focus();
}

els.btnName.addEventListener('click', openNameDialog);
els.nameForm.addEventListener('submit', (e) => {
  e.preventDefault();
  els.nameDialog.hidden = true;
  els.name.value = els.nameEdit.value;
  const name = myName();
  if (S.askName) {
    S.askName = false;
    connect();
    render();
    return;
  }
  if (S.view && name !== S.view.myName) send({ t: 'name', name });
});

function inviteLink(code = S.code) {
  return `${location.origin}${location.pathname}?c=${code}`;
}

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

els.btnCreate.addEventListener('click', () => {
  myName();
  createGame();
});
els.joinForm.addEventListener('submit', (e) => {
  e.preventDefault();
  myName();
  joinGame(els.joinCode.value);
});
els.joinCode.addEventListener('input', () => {
  els.joinCode.value = normalizeCode(els.joinCode.value);
});

// ---------------------------------------------------------------------------
// Pantalla «Mis partidas»
// ---------------------------------------------------------------------------

let summaries = new Map(); // code -> resumen del servidor
let homeTimer = 0;

function gameStatus(g, s) {
  if (!s) return { text: '…', mine: false };
  if (s.gone) return { text: 'Ya no existe', mine: false, gone: true };
  const rival = s.enemyName || 'tu rival';
  if (!s.enemyJoined) return { text: `Esperando que entre tu amigo · código ${g.code}`, mine: false };
  switch (s.phase) {
    case 'placing':
      if (!s.myReady) return { text: '🚢 Ubicá tus barcos', mine: true };
      return { text: `Esperando que ${rival} ubique sus barcos`, mine: false };
    case 'playing':
      return s.myTurn ? { text: '🎯 Te toca', mine: true } : { text: `Turno de ${rival}`, mine: false };
    case 'over': {
      const result = s.winner === 'me' ? '🏆 Ganaste' : (s.endReason === 'abandon' ? 'Abandonaste' : 'Perdiste');
      if (s.enemyLeft) return { text: `${result} · ${rival} dejó la partida`, mine: false, over: true };
      if (s.rematchEnemy && !s.rematchMe) return { text: `${result} · ${rival} quiere la revancha`, mine: true, over: true };
      return { text: result, mine: false, over: true };
    }
    default:
      return { text: '', mine: false };
  }
}

function renderGames() {
  const games = loadGames();
  const rows = games.map((g) => ({ g, s: summaries.get(g.code) }))
    .map((r) => ({ ...r, st: gameStatus(r.g, r.s) }))
    .sort((a, b) => (b.st.mine - a.st.mine) || ((b.s?.updatedAt || b.g.addedAt) - (a.s?.updatedAt || a.g.addedAt)));
  els.gamesEmpty.hidden = games.length > 0;
  els.gamesList.replaceChildren(...rows.map(({ g, s, st }) => {
    const li = document.createElement('li');
    li.className = 'game-row';
    if (st.mine) li.classList.add('mine');
    if (st.gone || st.over) li.classList.add('done');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'game-open';
    const title = document.createElement('span');
    title.className = 'g-title';
    title.textContent = `vs. ${s?.enemyName || g.enemyName || '(esperando rival)'}`;
    const status = document.createElement('span');
    status.className = 'g-status';
    status.textContent = st.text;
    open.append(title, status);
    open.addEventListener('click', () => {
      if (st.gone) {
        removeGame(g.code);
        renderGames();
        return;
      }
      openGame(g);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'g-remove ghost small';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', `Quitar la partida contra ${s?.enemyName || g.enemyName || 'tu rival'}`);
    remove.addEventListener('click', () => quitGame(g, s));
    li.append(open, remove);
    return li;
  }));
  updateAppBadge(rows.filter((r) => r.st.mine && !r.st.over).length);
}

async function refreshGames() {
  clearTimeout(homeTimer);
  renderGames();
  renderPushCard();
  const games = loadGames();
  if (games.length) {
    try {
      const { games: list } = await postJson('/api/games/summary', { games: games.map(({ code, token }) => ({ code, token })) });
      summaries = new Map(list.map((s) => [s.code, s]));
      for (const s of list) {
        if (s.enemyName) upsertGame({ code: s.code, enemyName: s.enemyName });
      }
      if (!els.screens.lobby.hidden) renderGames();
    } catch { /* sin conexión: queda lo que había */ }
  }
  if (!els.screens.lobby.hidden && !document.hidden) homeTimer = setTimeout(refreshGames, HOME_REFRESH_MS);
}

async function quitGame(g, s) {
  const rival = s?.enemyName || g.enemyName || 'tu rival';
  const active = s && !s.gone && s.enemyJoined && s.phase !== 'over';
  if (s && !s.gone && !s.enemyJoined && !confirm('¿Borrar esta partida? Tu amigo ya no va a poder entrar.')) return;
  if (active && !confirm(`¿Abandonar la partida contra ${rival}? Va a contar como que perdiste.`)) return;
  if (s && !s.gone) {
    try {
      await postJson('/api/games/leave', { code: g.code, token: g.token });
    } catch {
      alert('No se pudo avisar al servidor. Revisá tu internet y probá de nuevo.');
      return;
    }
  }
  removeGame(g.code);
  summaries.delete(g.code);
  renderGames();
}

function updateAppBadge(count) {
  try {
    if (count > 0) navigator.setAppBadge?.(count)?.catch(() => {});
    else navigator.clearAppBadge?.()?.catch(() => {});
  } catch { /* no soportado */ }
}

// ---------------------------------------------------------------------------
// Pasar las partidas a otro dispositivo
// ---------------------------------------------------------------------------
// El link lleva los tokens de tus partidas: quien lo abra puede jugarlas.

function exportLink() {
  const data = { n: els.name.value.trim(), g: loadGames().map((g) => [g.code, g.role, g.token, g.enemyName || '']) };
  return `${location.origin}${location.pathname}#importar=${b64urlEncode(new TextEncoder().encode(JSON.stringify(data)))}`;
}

els.btnTransfer.addEventListener('click', () => {
  if (!loadGames().length) {
    lobbyMsg('Todavía no tenés partidas para pasar.');
    return;
  }
  const link = exportLink();
  const actions = [
    {
      label: 'Copiar link',
      primary: true,
      onClick: async (e) => {
        try {
          await navigator.clipboard.writeText(link);
          e.target.textContent = '¡Copiado!';
        } catch {
          prompt('Copiá este link:', link);
        }
      },
    },
    { label: 'Cerrar', onClick: hideOverlay },
  ];
  if (navigator.share) {
    actions.splice(1, 0, {
      label: 'Compartir…',
      onClick: () => navigator.share({ title: 'Mis partidas de Batalla Naval', url: link }).catch(() => {}),
    });
  }
  showOverlay(
    'Pasar tus partidas',
    'Abrí este link en el otro dispositivo y vas a poder seguir tus partidas desde los dos. Mandátelo sólo a vos: cualquiera que lo tenga puede jugar en tu lugar.',
    actions,
  );
});

function importFromHash() {
  const m = location.hash.match(/^#importar=([A-Za-z0-9_-]+)$/);
  if (!m) return;
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const data = JSON.parse(new TextDecoder().decode(b64urlDecode(m[1])));
    let added = 0;
    for (const item of data.g || []) {
      const [code, role, token, enemyName] = item;
      if (normalizeCode(code).length !== CODE_LENGTH || !['host', 'guest'].includes(role) || typeof token !== 'string') continue;
      if (findGame(code)) continue;
      upsertGame({ code, role, token, enemyName: String(enemyName || '') });
      added++;
    }
    if (data.n && !els.name.value) {
      els.name.value = String(data.n).slice(0, 20);
      myName();
    }
    let msg = 'Esas partidas ya estaban en este dispositivo.';
    if (added === 1) msg = 'Listo: se agregó 1 partida.';
    else if (added > 1) msg = `Listo: se agregaron ${added} partidas.`;
    lobbyMsg(msg);
  } catch {
    lobbyMsg('El link para pasar partidas no es válido.', true);
  }
}

// ---------------------------------------------------------------------------
// Avisos (notificaciones push)
// ---------------------------------------------------------------------------

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let swReady = null;

if ('serviceWorker' in navigator) {
  swReady = navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).catch(() => null);
  // Al tocar una notificación con el juego ya abierto: ir a esa partida.
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data?.type !== 'open') return;
    const code = normalizeCode(new URL(e.data.url, location.href).searchParams.get('c'));
    if (code.length === CODE_LENGTH && code !== S.code) {
      const saved = findGame(code);
      if (saved) openGame(saved);
    }
  });
}

async function currentSubscription() {
  if (!pushSupported || !swReady) return null;
  const reg = await swReady;
  return reg ? reg.pushManager.getSubscription() : null;
}

async function serverKey() {
  const res = await fetch('/api/push/key');
  return (await res.json()).key;
}

function sameKey(sub, keyB64) {
  const k = sub.options?.applicationServerKey;
  if (!k) return true;
  return b64urlEncode(new Uint8Array(k)) === keyB64;
}

async function enablePush() {
  if (!pushSupported) return;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    renderPushCard();
    renderPushOffer();
    return;
  }
  try {
    const reg = await swReady;
    const keyB64 = await serverKey();
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, keyB64)) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlDecode(keyB64) });
    await syncPushAll(sub);
    S.pushOn = true;
    storageSet('bn-push', '1');
  } catch {
    alert('No se pudieron activar los avisos. Probá de nuevo más tarde.');
  }
  renderPushCard();
  if (!els.screens.game.hidden) render();
}

async function disablePush() {
  const sub = await currentSubscription();
  try { await sub?.unsubscribe(); } catch { /* ya estaba */ }
  S.pushOn = false;
  storageSet('bn-push', '0');
  const games = loadGames().map(({ code, token }) => ({ code, token }));
  if (games.length) postJson('/api/games/push', { games, sub: null }).catch(() => {});
  renderPushCard();
}

// Le pasa la suscripción a todas tus partidas (así el servidor sabe a dónde avisar).
async function syncPushAll(sub) {
  const games = loadGames().map(({ code, token }) => ({ code, token }));
  if (games.length) await postJson('/api/games/push', { games, sub: sub.toJSON() });
  if (socketOpen()) send({ t: 'push', sub: sub.toJSON() });
}

async function syncPushForCurrent() {
  const sub = await currentSubscription();
  if (sub && socketOpen()) send({ t: 'push', sub: sub.toJSON() });
}

function renderPushCard() {
  let text;
  let canEnable = false;
  if (S.pushOn) {
    text = '🔔 Avisos activados: te llega una notificación cuando te toca, aunque tengas el juego cerrado.';
  } else if (!pushSupported && isIOS && !standalone) {
    text = '🔔 Para recibir avisos en iPhone: tocá Compartir y después «Agregar a inicio». Abrí el juego desde ese ícono y activá los avisos.';
  } else if (!pushSupported) {
    text = 'Este navegador no permite avisos. Vas a ver tus turnos al entrar al juego.';
  } else if (Notification.permission === 'denied') {
    text = 'Bloqueaste los avisos para este sitio. Para recibirlos, permitilos desde la configuración del navegador.';
  } else {
    text = '🔔 Activá los avisos y te llega una notificación cuando te toque, aunque tengas el juego cerrado.';
    canEnable = true;
  }
  els.pushText.textContent = text;
  els.btnPush.hidden = !canEnable;
  els.btnPushOff.hidden = !S.pushOn;
  els.pushActions.hidden = !canEnable && !S.pushOn;
}

// En la partida, ofrecer los avisos cuando tiene sentido: te toca esperar al rival.
function renderPushOffer() {
  const v = V();
  const waiting = v && (!v.enemyJoined || v.myReady) && v.phase !== 'over' && !(v.phase === 'playing' && v.myTurn);
  els.pushOffer.hidden = !(waiting && pushSupported && !S.pushOn
    && Notification.permission === 'default' && storageGet('bn-push-dismissed') !== '1');
}

els.btnPush.addEventListener('click', enablePush);
els.btnPushOff.addEventListener('click', disablePush);
els.btnPushOffer.addEventListener('click', enablePush);
els.btnPushDismiss.addEventListener('click', () => {
  storageSet('bn-push-dismissed', '1');
  renderPushOffer();
});

// Al abrir: si los avisos estaban activados, se confirma la suscripción (puede
// haber cambiado) y se reparte a todas las partidas.
async function initPush() {
  const sub = await currentSubscription();
  S.pushOn = !!sub && Notification.permission === 'granted';
  if (S.pushOn) {
    try {
      const keyB64 = await serverKey();
      if (sameKey(sub, keyB64)) await syncPushAll(sub);
      else S.pushOn = false;
    } catch { /* sin conexión */ }
  }
  renderPushCard();
  if (!els.screens.game.hidden) render();
}

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------

els.name.value = storageGet('bn-name') || '';
importFromHash();
renderPushCard();
initPush();

// ?c=CÓDIGO: link de invitación o una partida tuya (por ejemplo, desde una notificación).
const linkCode = normalizeCode(new URLSearchParams(location.search).get('c'));
if (linkCode.length === CODE_LENGTH) {
  els.joinCode.value = linkCode;
  joinGame(linkCode, { askName: !els.name.value });
} else {
  refreshGames();
}
