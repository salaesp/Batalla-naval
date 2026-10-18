import { DurableObject } from 'cloudflare:workers';

// Cada partida es un Durable Object (una "sala") identificado por su código.
// La sala no conoce las reglas del juego: sólo reenvía los mensajes entre los dos
// jugadores y los guarda numerados, para que quien se desconecta un rato (por
// ejemplo, al cambiar de app en el celular) reciba al volver lo que se perdió.

const ROOM_PATH = /^\/api\/rooms\/([A-Z0-9]{5})\/ws$/;
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGE_BYTES = 8 * 1024;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(ROOM_PATH);
    if (match) {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Se esperaba un WebSocket', { status: 426 });
      }
      return env.ROOMS.get(env.ROOMS.idFromName(match[1])).fetch(request);
    }
    if (url.pathname.startsWith('/api/')) return new Response('No encontrado', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

const otherRole = (role) => (role === 'host' ? 'guest' : 'host');
const msgKey = (role, seq) => `m:${role}:${String(seq).padStart(8, '0')}`;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Responde los pings sin despertar a la sala.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const role = url.searchParams.get('role');
    const token = url.searchParams.get('token') || '';
    const since = Number.parseInt(url.searchParams.get('since'), 10) || 0;
    if ((role !== 'host' && role !== 'guest') || !TOKEN.test(token)) {
      return new Response('Parámetros inválidos', { status: 400 });
    }

    const { 0: client, 1: server } = new WebSocketPair();
    const storage = this.ctx.storage;
    const meta = (await storage.get('meta')) || {};

    let error = null;
    if (role === 'host' && meta.host && meta.host !== token) error = 'taken';
    if (role === 'guest' && !meta.host) error = 'not-found';
    if (role === 'guest' && meta.host && meta.guest && meta.guest !== token) error = 'full';
    if (error) {
      server.accept();
      server.send(JSON.stringify({ t: 'error', error }));
      server.close(4000, error);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (meta[role] !== token) {
      meta[role] = token;
      await storage.put('meta', meta);
    }

    // Si el mismo jugador ya tenía una conexión (vieja o colgada), se reemplaza.
    for (const ws of this.ctx.getWebSockets(role)) {
      ws.serializeAttachment({ replaced: true });
      try { ws.close(4001, 'replaced'); } catch { /* ya cerrada */ }
    }
    this.ctx.acceptWebSocket(server, [role]);

    const other = otherRole(role);
    server.send(JSON.stringify({
      t: 'welcome',
      lastSeq: (await storage.get(`seq:${role}`)) || 0,
      peerPresent: this.sockets(other).length > 0,
    }));
    // Lo que mandó el otro jugador y este todavía no recibió.
    const missed = await storage.list({ prefix: `m:${other}:`, start: msgKey(other, since + 1) });
    for (const raw of missed.values()) server.send(raw);

    this.broadcast(other, JSON.stringify({ t: 'peer', present: true }));
    await this.touch();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.t !== 'msg' || !Number.isInteger(msg.seq)) return;

    const role = this.ctx.getTags(ws)[0];
    const storage = this.ctx.storage;
    const last = (await storage.get(`seq:${role}`)) || 0;
    // Duplicado o fuera de orden: el cliente reenvía lo pendiente al reconectar.
    if (msg.seq !== last + 1) return;

    const out = JSON.stringify({ t: 'msg', seq: msg.seq, data: msg.data });
    await storage.put({ [`seq:${role}`]: msg.seq, [msgKey(role, msg.seq)]: out });
    this.broadcast(otherRole(role), out);
    ws.send(JSON.stringify({ t: 'ack', seq: msg.seq }));
    await this.touch();
  }

  async webSocketClose(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* ya cerrada */ }
    this.left(ws);
  }

  async webSocketError(ws) {
    this.left(ws);
  }

  // Borra la sala después de un día sin actividad.
  async alarm() {
    if (this.ctx.getWebSockets().length > 0) await this.touch();
    else await this.ctx.storage.deleteAll();
  }

  left(ws) {
    if (ws.deserializeAttachment()?.replaced) return;
    const role = this.ctx.getTags(ws)[0];
    if (this.sockets(role).some((w) => w !== ws)) return;
    this.broadcast(otherRole(role), JSON.stringify({ t: 'peer', present: false }));
  }

  sockets(role) {
    return this.ctx.getWebSockets(role).filter((ws) => ws.readyState === WebSocket.OPEN && !ws.deserializeAttachment()?.replaced);
  }

  broadcast(role, data) {
    for (const ws of this.sockets(role)) {
      try { ws.send(data); } catch { /* se fue */ }
    }
  }

  touch() {
    return this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }
}
