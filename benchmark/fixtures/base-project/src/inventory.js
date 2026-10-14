// Inventario en memoria.
import { normalizeSku } from './sku.js';

export class Inventory {
  constructor(initial = {}) {
    this.stock = new Map();
    for (const [sku, qty] of Object.entries(initial)) this.setStock(sku, qty);
  }

  setStock(rawSku, qty) {
    const sku = normalizeSku(rawSku);
    if (!sku) throw new Error(`SKU invalido: ${rawSku}`);
    this.stock.set(sku, qty);
  }

  available(rawSku) {
    return this.stock.get(normalizeSku(rawSku)) ?? 0;
  }

  reserve(rawSku, qty) {
    const sku = normalizeSku(rawSku);
    const have = this.stock.get(sku) ?? 0;
    if (qty > have) return false;
    this.stock.set(sku, have - qty);
    return true;
  }
}
