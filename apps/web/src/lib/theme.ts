import { useEffect, useState } from 'react';

const TOKENS = ['bg', 'surface', 'line', 'line-soft', 'text', 'muted', 'faint', 'price', 'accent', 'accent-strong', 'accent-soft', 'warn', 'warn-bar'] as const;
export type ThemeColors = Record<(typeof TOKENS)[number], string>;

function read(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(TOKENS.map((t) => [t, style.getPropertyValue(`--${t}`).trim() || '#888'])) as ThemeColors;
}

/** Couleurs du thème courant (clair ou sombre), mises à jour au changement de thème. */
export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(read);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setColors(read());
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return colors;
}

/** Ajoute une opacité à une couleur hexadécimale. */
export function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
