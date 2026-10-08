// Web Push sans dépendance : chiffrement du message (RFC 8291, aes128gcm) et authentification
// du serveur d'application (VAPID, RFC 8292), avec la seule API WebCrypto.

export interface PushSubscriptionKeys {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface VapidKeys {
  /** Clé publique brute (65 octets) en base64url, celle que la PWA donne à pushManager.subscribe. */
  publicKey: string;
  /** Clé privée au format JWK (avec x, y et d). */
  privateJwk: JsonWebKey;
}

export interface PushOptions {
  /** Durée de conservation par le service push si l'appareil est injoignable (secondes). */
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  /** Remplace un message de même sujet encore en attente (32 caractères base64url au plus). */
  topic?: string;
  /** « sub » du jeton VAPID : mailto: ou https: du responsable. */
  subject: string;
}

const enc = new TextEncoder();
/** Vue d'octets vers BufferSource (les typages récents distinguent ArrayBuffer et SharedArrayBuffer). */
const bs = (b: Uint8Array) => b as unknown as BufferSource;

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', bs(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: bs(salt), info: bs(info) }, key, length * 8);
  return new Uint8Array(bits);
}

/** Paire de clés VAPID (ECDSA P-256), à générer une fois par instance. */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const raw = await crypto.subtle.exportKey('raw', pair.publicKey);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  return { publicKey: b64urlEncode(raw), privateJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d } };
}

/** Jeton VAPID (JWT ES256) pour l'origine du service push. */
export async function vapidToken(endpoint: string, keys: VapidKeys, subject: string, now = Date.now()): Promise<string> {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = b64urlEncode(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })));
  const key = await crypto.subtle.importKey('jwk', { ...keys.privateJwk, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  // WebCrypto renvoie la signature brute r‖s (64 octets), le format attendu par JWS.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, bs(enc.encode(`${header}.${payload}`)));
  return `${header}.${payload}.${b64urlEncode(sig)}`;
}

/** Chiffre un message pour un abonnement (un seul enregistrement, sans remplissage). */
export async function encryptPayload(
  sub: Pick<PushSubscriptionKeys, 'p256dh' | 'auth'>,
  plaintext: Uint8Array,
  salt: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): Promise<Uint8Array> {
  const uaPublic = b64urlDecode(sub.p256dh);
  const authSecret = b64urlDecode(sub.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('clé p256dh invalide');
  if (authSecret.length < 16) throw new Error('secret auth invalide');
  const rs = 4096;
  if (plaintext.length + 1 + 16 > rs) throw new Error('message trop long pour Web Push');

  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', bs(uaPublic), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aes = await crypto.subtle.importKey('raw', bs(cek), 'AES-GCM', false, ['encrypt']);
  // délimiteur 0x02 : dernier (et seul) enregistrement
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: bs(nonce) }, aes, bs(concat(plaintext, new Uint8Array([2])))));

  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

export interface PushResult {
  ok: boolean;
  status: number;
  /** L'abonnement n'existe plus (404, 410) : à supprimer. */
  gone: boolean;
  error?: string;
}

/** Envoie un message JSON à un abonnement. Ne lève pas d'exception : le résultat dit quoi faire. */
export async function sendPush(
  sub: PushSubscriptionKeys,
  message: unknown,
  keys: VapidKeys,
  options: PushOptions,
): Promise<PushResult> {
  try {
    const body = await encryptPayload(sub, enc.encode(JSON.stringify(message)));
    const token = await vapidToken(sub.endpoint, keys, options.subject);
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
      'Content-Encoding': 'aes128gcm',
      TTL: String(options.ttl ?? 24 * 3600),
      Urgency: options.urgency ?? 'normal',
      Authorization: `vapid t=${token}, k=${keys.publicKey}`,
    };
    if (options.topic) headers.Topic = options.topic;
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body: bs(body), signal: AbortSignal.timeout(15_000) });
    const text = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 300);
    if (res.ok) await res.body?.cancel().catch(() => {});
    return {
      ok: res.ok,
      status: res.status,
      gone: res.status === 404 || res.status === 410,
      error: res.ok ? undefined : `HTTP ${res.status}${text ? ` : ${text}` : ''}`,
    };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: (e as Error).message };
  }
}
