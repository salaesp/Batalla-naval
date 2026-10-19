import { DurableObject } from 'cloudflare:workers';
import { b64url, encryptPayload, vapidAuth, validSubscription } from './webpush.js';

export { validSubscription };

// Las claves VAPID (con las que el servidor firma cada aviso) se generan solas la
// primera vez y quedan guardadas en este Durable Object: no hay que configurar
// nada en Cloudflare. Hay una sola instancia (idFromName('vapid')).

const enc = new TextEncoder();

export class Pusher extends DurableObject {
  async vapid() {
    if (this.keys) return this.keys;
    let keys = await this.ctx.storage.get('vapid');
    if (!keys) {
      const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
      keys = {
        publicKey: b64url(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey))),
        privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
      };
      await this.ctx.storage.put('vapid', keys);
    }
    this.keys = keys;
    return keys;
  }

  async publicKey() {
    return (await this.vapid()).publicKey;
  }

  // Manda un aviso. `gone` indica que la suscripción ya no existe y hay que olvidarla.
  async send(sub, payload, { subject, topic, urgency = 'normal' } = {}) {
    if (!validSubscription(sub)) return { ok: false, gone: true };
    try {
      const vapid = await this.vapid();
      const headers = {
        Authorization: await vapidAuth(sub.endpoint, vapid, subject || 'mailto:batalla-naval@example.com'),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(7 * 24 * 60 * 60),
        Urgency: urgency,
      };
      // Con el mismo tema, el servicio de push reemplaza un aviso todavía no entregado.
      if (topic) headers.Topic = topic;
      const body = await encryptPayload(sub, enc.encode(JSON.stringify(payload)));
      const res = await fetch(sub.endpoint, { method: 'POST', headers, body });
      return { ok: res.ok, gone: res.status === 404 || res.status === 410, status: res.status };
    } catch (err) {
      return { ok: false, gone: false, error: String(err) };
    }
  }
}
