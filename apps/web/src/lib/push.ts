// Abonnement Web Push du navigateur courant : permission, clé VAPID du serveur, enregistrement en base.
import { runJob, supabase, unwrap } from './supabase';

export type PushSupport = 'ok' | 'unsupported' | 'ios-install' | 'denied';

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalone(): boolean {
  return window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** Ce que permet ce navigateur. Sur iPhone et iPad, il faut d'abord installer la PWA sur l'écran d'accueil. */
export function pushSupport(): PushSupport {
  const capable = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!capable) return isIos() && !isStandalone() ? 'ios-install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

function b64urlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, '='));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await navigator.serviceWorker.getRegistration();
  if (reg?.active) return reg;
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('service worker absent : rechargez la page (ou utilisez la version installée)')), 8000));
  return Promise.race([ready, timeout]);
}

export async function browserSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok' && pushSupport() !== 'denied') return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Libellé lisible de l'appareil (navigateur · système). */
export function deviceLabel(ua = navigator.userAgent): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /SamsungBrowser/.test(ua) ? 'Samsung Internet'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' · ') + (isStandalone() ? ' (appli installée)' : '');
}

export async function saveSubscription(sub: PushSubscription): Promise<void> {
  const j = sub.toJSON();
  if (!j.endpoint || !j.keys?.p256dh || !j.keys?.auth) throw new Error('abonnement incomplet renvoyé par le navigateur');
  unwrap(await supabase.rpc('push_subscribe', {
    p_endpoint: j.endpoint,
    p_p256dh: j.keys.p256dh,
    p_auth: j.keys.auth,
    p_user_agent: deviceLabel(),
  }));
}

/** Active les notifications sur cet appareil pour le compte connecté (à appeler depuis un clic). */
export async function enablePush(): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied'
      ? 'notifications refusées : autorisez-les dans les réglages du navigateur pour ce site'
      : 'autorisation non accordée');
  }
  const { publicKey } = (await runJob('push-key', { origin: window.location.origin })) as { publicKey?: string };
  if (!publicKey) throw new Error('clé du serveur indisponible');
  const key = b64urlToBytes(publicKey);
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await saveSubscription(sub);
}

/** Désactive cet appareil : oublié par le serveur, désabonné du service push. */
export async function disablePush(): Promise<void> {
  const sub = await browserSubscription();
  if (!sub) return;
  unwrap(await supabase.rpc('push_unsubscribe', { p_endpoint: sub.endpoint }));
  await sub.unsubscribe();
}

/** À la déconnexion : le serveur oublie l'appareil (un autre compte pourra s'y abonner). */
export async function forgetDevice(): Promise<void> {
  try {
    const sub = await browserSubscription();
    if (sub) await supabase.rpc('push_unsubscribe', { p_endpoint: sub.endpoint });
  } catch {
    /* hors ligne : sans conséquence */
  }
}
