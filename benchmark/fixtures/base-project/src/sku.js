// Normalizacion de codigos SKU: mayusculas, sin espacios, formato AAA-0000.
const SKU_RE = /^[A-Z]{3}-\d{4}$/;

export function normalizeSku(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toUpperCase().replace(/\s+/g, '').replace(/_/g, '-');
  return SKU_RE.test(s) ? s : null;
}

export function isValidSku(raw) {
  return normalizeSku(raw) !== null;
}
