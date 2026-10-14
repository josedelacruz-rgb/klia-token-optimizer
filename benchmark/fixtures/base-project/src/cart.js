// Carrito de compra.
import { normalizeSku } from './sku.js';
import { finalPrice } from './pricing.js';

export class Cart {
  constructor() {
    this.lines = new Map();
  }

  add(product, qty = 1) {
    const sku = normalizeSku(product.sku);
    if (!sku) throw new Error(`SKU invalido: ${product.sku}`);
    if (!Number.isInteger(qty) || qty <= 0) throw new Error('Cantidad invalida');
    const prev = this.lines.get(sku);
    this.lines.set(sku, { product, qty: (prev ? prev.qty : 0) + qty });
  }

  remove(sku) {
    return this.lines.delete(normalizeSku(sku));
  }

  count() {
    let n = 0;
    for (const line of this.lines.values()) n += line.qty;
    return n;
  }

  total(discountPct = 0) {
    let sum = 0;
    for (const { product, qty } of this.lines.values()) {
      sum += finalPrice(product, discountPct) * qty;
    }
    return sum;
  }
}
