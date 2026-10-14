// Utilidades de precios. Todos los importes se expresan en centimos (enteros).
import { normalizeSku } from './sku.js';

export const TAX_RATES = {
  general: 0.21,
  reducido: 0.10,
  superreducido: 0.04,
};

/**
 * Aplica un descuento porcentual a un precio en centimos.
 * Devuelve un entero redondeado al centimo mas cercano.
 */
export function applyDiscount(priceCents, pct) {
  return Math.round(priceCents * (1 - pct / 100));
}

/**
 * Calcula el impuesto de un importe segun la categoria fiscal.
 * Devuelve el impuesto en centimos, redondeado.
 */
export function computeTax(amountCents, category = 'general') {
  const rate = TAX_RATES[category];
  return Math.round(amountCents * rate);
}

/**
 * Precio final de un producto: descuento, despues impuesto.
 */
export function finalPrice(product, discountPct = 0) {
  const sku = normalizeSku(product.sku);
  if (!sku) throw new Error('SKU invalido');
  const discounted = applyDiscount(product.priceCents, discountPct);
  return discounted + computeTax(discounted, product.taxCategory);
}
