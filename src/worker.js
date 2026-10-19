import { DurableObject } from 'cloudflare:workers';
import { cleanName, coordName, validCoord, validFleet } from './rules.js';
import { Pusher, validSubscription } from './push.js';

export { Pusher };

// Cada partida es un Durable Object (una "sala") identificado por su código. La
// sala guarda la partida entera (flotas, disparos, chat) y aplica las reglas, así
// se puede jugar de a ratos: cada uno entra cuando quiere y, si tiene los avisos
// activados, le llega una notificación cuando le toca.
//
// Cada jugador se identifica con un token que genera su navegador al crear o
// unirse a la partida y que guarda en su lista de partidas.

const CODE = /^[A-Z0-9]{5}$/;
const ROOM_PATH = /^\/api\/rooms\/([A-Z0-9]{5})\/ws$/;
const TOKEN = /^[A-Za-z0-9_-]{16,64}$/;
const GAME_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_BYTES = 8 * 1024;
const MAX_CHAT = 100;
const MAX_GAMES_PER_REQUEST = 50;

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

// [{ code, token }] válidos, sin repetir y con un máximo.
function gameRefs(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((g) => g && CODE.test(g.code) && TOKEN.test(g.token)).slice(0, MAX_GAMES_PER_REQUEST);
}

const room = (env, code) => env.ROOMS.get(env.ROOMS.idFromName(code));
const pusher = (env) => env.PUSHER.get(env.PUSHER.idFromName('vapid'));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    const match = path.match(ROOM_PATH);
    if (match) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Se esperaba un WebSocket', { status: 426 });
      }
      return room(env, match[1]).fetch(request);
    }

    // Estado resumido de varias partidas, para la pantalla «Mis partidas».
    if (path === '/api/games/summary' && request.method === 'POST') {
      const refs = gameRefs((await readJson(request))?.games);
      const out = await Promise.all(refs.map(async ({ code, token }) => ({
        code, ...(await room(env, code).summary(token)),
      })));
      return json({ games: out });
    }

    // Guarda (o borra, con sub: null) la suscripción de avisos en varias partidas.
    if (path === '/api/games/push' && request.method === 'POST') {
      const body = await readJson(request);
      const sub = body?.sub ?? null;
      if (sub !== null && !validSubscription(sub)) return json({ error: 'bad-subscription' }, 400);
      await Promise.all(gameRefs(body?.games).map(({ code, token }) => room(env, code).setPush(token, sub)));
      return json({ ok: true });
    }

    if (path === '/api/games/leave' && request.method === 'POST') {
      const [ref] = gameRefs([await readJson(request)]);
      if (!ref) return json({ error: 'bad-request' }, 400);
      await room(env, ref.code).abandon(ref.token);
      return json({ ok: true });
    }

    if (path === '/api/push/key') {
      return json({ key: await pusher(env).publicKey() });
    }

    if (path.startsWith('/api/')) return new Response('No encontrado', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

const otherRole = (role) => (role === 'host' ? 'guest' : 'host');

function newPlayer(token, name) {
  return { token, name, ships: null, shots: [], rematch: false, push: null, left: false };
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Responde los pings sin despertar a la sala.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    ctx.blockConcurrencyWhile(async () => {
      this.game = (await ctx.storage.get('game')) || null;
    });
  }

  // ---------------------------------------------------------------------------
  // Conexiones
  // ---------------------------------------------------------------------------

  async fetch(request) {
    const url = new URL(request.url);
    const code = url.pathname.match(ROOM_PATH)?.[1];
    const role = url.searchParams.get('role');
    const token = url.searchParams.get('token') || '';
    if (!code || (role !== 'host' && role !== 'guest') || !TOKEN.test(token)) {
      return new Response('Parámetros inválidos', { status: 400 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    const error = await this.admit({
      code,
      role,
      token,
      create: url.searchParams.get('create') === '1',
      name: cleanName(url.searchParams.get('name')),
      origin: url.origin,
    });
    if (error) {
      server.accept();
      server.send(JSON.stringify({ t: 'error', error }));
      server.close(4000, error);
      return new Response(null, { status: 101, webSocket: client });
    }

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, visible: true });
    server.send(JSON.stringify({ t: 'state', view: this.view(role) }));
    this.broadcastPeer(otherRole(role));
    return new Response(null, { status: 101, webSocket: client });
  }

  // Decide si el jugador puede entrar. Crea la partida o suma al invitado si hace falta.
  async admit({ code, role, token, create, name, origin }) {
    const g = this.game;
    if (!g) {
      if (role !== 'host' || !create) return 'not-found';
      const now = Date.now();
      this.game = {
        code,
        origin,
        createdAt: now,
        updatedAt: now,
        round: 1,
        phase: 'placing', // placing | playing | over
        turn: null,
        turnSince: null,
        reminded: false,
        winner: null,
        endReason: null, // sunk | abandon
        chatSeq: 0,
        chat: [],
        players: { host: newPlayer(token, name), guest: null },
      };
      this.save();
      return null;
    }
    const p = g.players[role];
    if (p) {
      if (p.token === token) return null;
      return role === 'host' ? 'taken' : 'full';
    }
    if (role !== 'guest') return 'not-found';
    g.players.guest = newPlayer(token, name);
    this.save();
    this.broadcastState({ kind: 'joined', by: 'guest' });
    await this.notify('host', `${name} se unió a la partida`, 'Ya pueden ubicar sus barcos.');
    return null;
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES || !this.game) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    const { role } = ws.deserializeAttachment() || {};
    if (!role || !this.game.players[role]) return;

    switch (m?.t) {
      case 'visible':
        ws.serializeAttachment({ role, visible: !!m.visible });
        return;
      case 'name': return this.rename(role, m.name);
      case 'place':
        if (!(await this.place(role, m.ships))) this.sendState(ws, role);
        return;
      case 'shoot':
        if (!(await this.shoot(role, m.x, m.y))) this.sendState(ws, role);
        return;
      case 'chat': return this.chat(role, m.text);
      case 'rematch': return this.rematch(role);
      case 'push':
        this.setPushFor(role, m.sub);
        this.sendState(ws, role);
        return;
    }
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* ya cerrada */ }
    this.left(ws);
  }

  async webSocketError(ws) {
    this.left(ws);
  }

  left(ws) {
    const { role } = ws.deserializeAttachment() || {};
    if (role) this.broadcastPeer(otherRole(role), ws);
  }

  // ---------------------------------------------------------------------------
  // Jugadas
  // ---------------------------------------------------------------------------

  async rename(role, raw) {
    const p = this.game.players[role];
    const name = cleanName(raw);
    if (name === p.name) return;
    const old = p.name;
    p.name = name;
    this.save();
    this.broadcastState({ kind: 'name', by: role, old, name });
  }

  async place(role, ships) {
    const g = this.game;
    const p = g.players[role];
    const other = g.players[otherRole(role)];
    if (g.phase !== 'placing' || p.ships) return false;
    const fleet = validFleet(ships);
    if (!fleet) return false;
    p.ships = fleet;
    if (other?.ships) {
      g.phase = 'playing';
      g.turn = Math.random() < 0.5 ? 'host' : 'guest';
      this.startTurn();
      this.save();
      this.broadcastState({ kind: 'start', first: g.turn });
      const rival = g.players[otherRole(g.turn)].name;
      await this.notify(g.turn, '¡Empieza la batalla!', `Arrancás vos contra ${rival}. ¡Te toca disparar!`, { urgency: 'high' });
    } else {
      this.save();
      this.broadcastState({ kind: 'ready', by: role });
      if (other) await this.notify(otherRole(role), `${p.name} ya ubicó su flota`, 'Ubicá la tuya para empezar.');
    }
    return true;
  }

  async shoot(role, x, y) {
    const g = this.game;
    const p = g.players[role];
    const otherR = otherRole(role);
    const other = g.players[otherR];
    if (g.phase !== 'playing' || g.turn !== role || !validCoord(x, y)) return false;
    if (p.shots.some((s) => s.x === x && s.y === y)) return false;

    const ship = other.ships.find((s) => s.cells.some((c) => c.x === x && c.y === y));
    if (ship) ship.hits++;
    p.shots.push({ x, y, r: ship ? 'hit' : 'miss' });
    const sunk = ship && ship.hits === ship.size ? ship.name : null;
    const over = other.ships.every((s) => s.hits === s.size);
    const where = coordName(x, y);

    if (over) {
      this.finish(role, 'sunk');
      this.save();
      this.broadcastState({ kind: 'shot', by: role, x, y, r: 'hit', sunk });
      await this.notify(otherR, `${p.name} ganó la partida`, 'Hundió toda tu flota. ¿Revancha?');
      return true;
    }

    g.turn = otherR;
    this.startTurn();
    this.save();
    this.broadcastState({ kind: 'shot', by: role, x, y, r: ship ? 'hit' : 'miss', sunk });
    let what = `Tiró al agua en ${where}.`;
    if (sunk) what = `Hundió tu ${sunk.toLowerCase()}.`;
    else if (ship) what = `Te tocó en ${where}.`;
    await this.notify(otherR, `${p.name} disparó: ¡te toca!`, what, { urgency: 'high' });
    return true;
  }

  async chat(role, raw) {
    const g = this.game;
    const text = String(raw ?? '').trim().slice(0, 200);
    if (!text) return;
    const id = ++g.chatSeq;
    g.chat.push({ id, from: role, text, at: Date.now() });
    if (g.chat.length > MAX_CHAT) g.chat.splice(0, g.chat.length - MAX_CHAT);
    this.save();
    this.broadcastState({ kind: 'chat', by: role, id });
    await this.notify(otherRole(role), g.players[role].name, text, { chat: true });
  }

  async rematch(role) {
    const g = this.game;
    const p = g.players[role];
    const other = g.players[otherRole(role)];
    if (g.phase !== 'over' || p.rematch || !other || other.left || p.left) return;
    p.rematch = true;
    if (other.rematch) {
      g.round++;
      g.phase = 'placing';
      g.turn = null;
      g.turnSince = null;
      g.winner = null;
      g.endReason = null;
      for (const pl of [p, other]) {
        pl.ships = null;
        pl.shots = [];
        pl.rematch = false;
      }
      this.save();
      this.broadcastState({ kind: 'newround' });
      await this.notify(otherRole(role), '¡Revancha!', `${p.name} aceptó. Ubicá tus barcos.`);
    } else {
      this.save();
      this.broadcastState({ kind: 'rematch', by: role });
      await this.notify(otherRole(role), `${p.name} quiere la revancha`, 'Entrá para jugar otra.');
    }
  }

  // Un jugador deja la partida (desde «Mis partidas»).
  async abandon(token) {
    const g = this.game;
    const role = this.roleOf(token);
    if (!role) return;
    const p = g.players[role];
    const otherR = otherRole(role);
    const other = g.players[otherR];
    // Nadie se había unido todavía: la partida se borra.
    if (!other) {
      await this.destroy();
      return;
    }
    p.left = true;
    p.push = null;
    if (g.phase !== 'over') {
      this.finish(otherR, 'abandon');
      this.save();
      this.broadcastState({ kind: 'abandon', by: role });
      await this.notify(otherR, `${p.name} abandonó la partida`, 'Ganaste vos.');
      return;
    }
    p.rematch = false;
    this.save();
    this.broadcastState({ kind: 'abandon', by: role });
  }

  finish(winner, reason) {
    const g = this.game;
    g.phase = 'over';
    g.turn = null;
    g.turnSince = null;
    g.winner = winner;
    g.endReason = reason;
  }

  startTurn() {
    this.game.turnSince = Date.now();
    this.game.reminded = false;
  }

  // ---------------------------------------------------------------------------
  // Avisos
  // ---------------------------------------------------------------------------

  setPushFor(role, sub) {
    const p = this.game.players[role];
    if (sub !== null && !validSubscription(sub)) return;
    p.push = sub;
    this.save(false);
  }

  // Avisa al jugador, salvo que tenga la partida abierta a la vista.
  async notify(role, title, body, { chat = false, urgency = 'normal' } = {}) {
    const g = this.game;
    const p = g?.players[role];
    if (!p?.push || p.left) return;
    if (this.sockets(role).some((ws) => ws.deserializeAttachment()?.visible)) return;
    const sub = p.push;
    const res = await pusher(this.env).send(sub, {
      title,
      body,
      code: g.code,
      tag: chat ? `chat-${g.code}` : `game-${g.code}`,
      silent: chat,
      url: `/?c=${g.code}`,
    }, {
      subject: g.origin?.startsWith('https://') ? g.origin : undefined,
      topic: `${chat ? 'c' : 'g'}${g.code}`,
      urgency,
    });
    if (res.gone && this.game?.players[role]?.push === sub) {
      this.game.players[role].push = null;
      this.save(false);
    }
  }

  // ---------------------------------------------------------------------------
  // Llamadas desde el Worker
  // ---------------------------------------------------------------------------

  roleOf(token) {
    const g = this.game;
    if (!g || !TOKEN.test(token)) return null;
    if (g.players.host?.token === token) return 'host';
    if (g.players.guest?.token === token) return 'guest';
    return null;
  }

  summary(token) {
    const role = this.roleOf(token);
    if (!role) return { gone: true };
    const v = this.view(role);
    return {
      role,
      phase: v.phase,
      enemyName: v.enemyName,
      enemyJoined: v.enemyJoined,
      enemyLeft: v.enemyLeft,
      myTurn: v.myTurn,
      myReady: v.myReady,
      enemyReady: v.enemyReady,
      winner: v.winner,
      endReason: v.endReason,
      rematchEnemy: v.rematch.enemy,
      rematchMe: v.rematch.me,
      updatedAt: this.game.updatedAt,
    };
  }

  setPush(token, sub) {
    const role = this.roleOf(token);
    if (role) this.setPushFor(role, sub);
  }

  // ---------------------------------------------------------------------------
  // Estado
  // ---------------------------------------------------------------------------

  // Lo que ve cada jugador: nunca la flota del rival mientras se juega.
  view(role) {
    const g = this.game;
    const me = g.players[role];
    const otherR = otherRole(role);
    const other = g.players[otherR];
    const enemyShips = other?.ships || [];
    return {
      code: g.code,
      role,
      round: g.round,
      phase: g.phase,
      myName: me.name,
      enemyName: other?.name ?? null,
      enemyJoined: !!other,
      enemyLeft: !!other?.left,
      myReady: !!me.ships,
      enemyReady: !!other?.ships,
      myShips: me.ships,
      myTurn: g.phase === 'playing' && g.turn === role,
      outgoing: me.shots,
      incoming: other?.shots || [],
      sunk: enemyShips.filter((s) => s.hits === s.size).map((s) => ({ name: s.name, cells: s.cells })),
      reveal: g.phase === 'over' ? enemyShips.map((s) => s.cells) : [],
      winner: g.winner ? (g.winner === role ? 'me' : 'enemy') : null,
      endReason: g.endReason,
      rematch: { me: me.rematch, enemy: !!other?.rematch },
      chat: g.chat.map((c) => ({ id: c.id, mine: c.from === role, text: c.text, at: c.at })),
      peerOnline: this.sockets(otherR).length > 0,
      pushOn: !!me.push,
    };
  }

  // El evento indica qué cambió, para que el cliente anime o avise.
  eventFor(role, event) {
    if (!event) return undefined;
    const out = { ...event };
    if ('by' in out) out.by = out.by === role ? 'me' : 'enemy';
    if ('first' in out) out.first = out.first === role ? 'me' : 'enemy';
    return out;
  }

  sendState(ws, role, event) {
    try { ws.send(JSON.stringify({ t: 'state', view: this.view(role), event: this.eventFor(role, event) })); } catch { /* se fue */ }
  }

  broadcastState(event) {
    for (const ws of this.sockets()) {
      const { role } = ws.deserializeAttachment() || {};
      if (role) this.sendState(ws, role, event);
    }
  }

  broadcastPeer(role, except = null) {
    const present = this.sockets(otherRole(role)).some((ws) => ws !== except);
    for (const ws of this.sockets(role)) {
      try { ws.send(JSON.stringify({ t: 'peer', present })); } catch { /* se fue */ }
    }
  }

  sockets(role) {
    const list = role ? this.ctx.getWebSockets(role) : this.ctx.getWebSockets();
    return list.filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  save(touch = true) {
    const g = this.game;
    if (!g) return;
    if (touch) g.updatedAt = Date.now();
    this.ctx.storage.put('game', g);
    this.schedule();
  }

  // Una sola alarma: el recordatorio de turno o el borrado por inactividad.
  schedule() {
    const g = this.game;
    let at = g.updatedAt + GAME_TTL_MS;
    if (g.phase === 'playing' && !g.reminded && g.turnSince) at = Math.min(at, g.turnSince + REMIND_AFTER_MS);
    this.ctx.storage.setAlarm(at);
  }

  async alarm() {
    const g = this.game;
    // Salas viejas (de antes de guardar la partida entera): se limpian.
    if (!g) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    if (now >= g.updatedAt + GAME_TTL_MS) {
      await this.destroy();
      return;
    }
    if (g.phase === 'playing' && !g.reminded && g.turnSince && now >= g.turnSince + REMIND_AFTER_MS) {
      g.reminded = true;
      this.save(false);
      const rival = g.players[otherRole(g.turn)].name;
      await this.notify(g.turn, `Te toca contra ${rival}`, 'Hace un día que te está esperando tu turno.');
      return;
    }
    this.schedule();
  }

  async destroy() {
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(JSON.stringify({ t: 'error', error: 'not-found' }));
        ws.close(4000, 'not-found');
      } catch { /* ya cerrada */ }
    }
    this.game = null;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
