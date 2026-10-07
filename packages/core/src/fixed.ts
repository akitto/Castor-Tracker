/**
 * Arithmétique exacte pour la formule officielle : les cours sont convertis
 * en dix-millièmes d'euro (entiers) et l'arrondi final se fait en entiers.
 */
export type Rounding = 'nearest' | 'up' | 'down';

export const PRICE_SCALE = 10_000;

export function toUnits(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error(`cours invalide : ${value}`);
  return BigInt(Math.round(value * PRICE_SCALE));
}

/** Division entière de nombres positifs avec arrondi (au plus proche : demi vers le haut). */
export function divRound(num: bigint, den: bigint, mode: Rounding): bigint {
  if (den <= 0n) throw new Error('diviseur nul ou négatif');
  if (num < 0n) throw new Error('numérateur négatif');
  const q = num / den;
  const r = num % den;
  if (r === 0n) return q;
  if (mode === 'down') return q;
  if (mode === 'up') return q + 1n;
  return 2n * r >= den ? q + 1n : q;
}

/** Arrondi d'un montant flottant au centime, selon le mode. */
export function roundCents(value: number, mode: Rounding = 'nearest'): number {
  const cents = value * 100;
  if (mode === 'down') return Math.floor(cents + 1e-7) / 100;
  if (mode === 'up') return Math.ceil(cents - 1e-7) / 100;
  return Math.round(cents + 1e-9) / 100;
}
