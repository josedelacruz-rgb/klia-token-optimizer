/**
 * Formateadores puros para la presentacion de estadisticas.
 *
 * Sin color ni estado global: reciben y devuelven strings, de modo que son
 * faciles de testear y reutilizar. Los helpers que dependen del color ANSI
 * permanecen en stats-display.ts.
 */

/** Rellena un string a `len` caracteres visibles, ignorando codigos ANSI. */
export function pad(str: string, len: number, align: 'left' | 'right' | 'center' = 'left'): string {
  const s = String(str);
  const visibleLen = s.replace(/\x1b\[[0-9;]*m/g, '').length;
  const padLen = Math.max(0, len - visibleLen);
  if (align === 'right') return ' '.repeat(padLen) + s;
  if (align === 'center') {
    const left = Math.floor(padLen / 2);
    const right = padLen - left;
    return ' '.repeat(left) + s + ' '.repeat(right);
  }
  return s + ' '.repeat(padLen);
}

export function fmt(n: number | null | undefined, decimals = 1): string {
  if (n === null || n === undefined) return '-';
  if (!Number.isFinite(n)) return 'inf';
  return n.toFixed(decimals);
}

export function fmtInt(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  if (!Number.isFinite(n)) return 'inf';
  return Math.round(n).toLocaleString('en-US');
}

export function fmtPct(n: number | null | undefined, sign = false): string {
  if (n === null || n === undefined) return '-';
  if (!Number.isFinite(n)) return '-';
  const prefix = sign && n > 0 ? '+' : '';
  return `${prefix}${n.toFixed(1)}%`;
}

export function fmtUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '-';
  if (!Number.isFinite(n) || n === 0) return '$0';
  if (Math.abs(n) < 0.01) return `$${n.toExponential(2)}`;
  return `$${n.toFixed(4)}`;
}
