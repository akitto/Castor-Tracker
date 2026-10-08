// Interopérabilité du chiffrement Web Push (RFC 8291) et du jeton VAPID avec les bibliothèques
// de référence (http_ece, utilisée par web-push). Lancé par scripts/test-db.sh (RUN_FUNCTIONS=1).
import { createECDH, randomBytes } from 'node:crypto';
import ece from 'npm:http_ece@1.2.0';
import { b64urlDecode, b64urlEncode, encryptPayload, generateVapidKeys, vapidToken } from '../../functions/castor-jobs/webpush.ts';

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(`ÉCHEC : ${message}`);
}

Deno.test('Web Push : message déchiffré par http_ece (aes128gcm)', async () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const authSecret = randomBytes(16);
  const sub = { p256dh: b64urlEncode(new Uint8Array(ua.getPublicKey())), auth: b64urlEncode(new Uint8Array(authSecret)) };
  const message = JSON.stringify({ title: 'Prix Castor 2027/1 : 106,50 €', body: 'Écart +0,40 €', url: '/historique' });
  const body = await encryptPayload(sub, new TextEncoder().encode(message));
  const clear = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: ua, authSecret: Buffer.from(authSecret) });
  assert(clear.toString('utf8') === message, 'message identique après déchiffrement');
});

Deno.test('Web Push : jeton VAPID ES256 vérifiable', async () => {
  const keys = await generateVapidKeys();
  assert(b64urlDecode(keys.publicKey).length === 65, 'clé publique brute de 65 octets');
  const token = await vapidToken('https://fcm.googleapis.com/fcm/send/abc', keys, 'mailto:admin@example.org', Date.parse('2026-10-08T12:00:00Z'));
  const [h, p, s] = token.split('.');
  const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
  assert(payload.aud === 'https://fcm.googleapis.com' && payload.sub === 'mailto:admin@example.org', 'audience et sujet');
  assert(payload.exp === Date.parse('2026-10-08T12:00:00Z') / 1000 + 12 * 3600, 'expiration à 12 h');
  const pub = await crypto.subtle.importKey('raw', b64urlDecode(keys.publicKey) as unknown as BufferSource, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, b64urlDecode(s) as unknown as BufferSource, new TextEncoder().encode(`${h}.${p}`));
  assert(ok, 'signature valide avec la clé publique');
});
