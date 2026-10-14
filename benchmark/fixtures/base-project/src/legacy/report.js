// Generador de informes heredado. Funciona, pero es dificil de mantener.
import { normalizeSku } from '../sku.js';

export function buildReport(orders) {
  let out = '';
  let total = 0;
  let count = 0;
  const bySku = {};
  out = out + 'INFORME DE PEDIDOS\n';
  out = out + '==================\n';
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i];
    if (o.status === 'cancelled') {
      continue;
    }
    if (o.status !== 'paid' && o.status !== 'shipped') {
      continue;
    }
    count = count + 1;
    let orderTotal = 0;
    for (let j = 0; j < o.lines.length; j++) {
      const l = o.lines[j];
      const sku = normalizeSku(l.sku);
      if (sku === null) {
        continue;
      }
      const lineTotal = l.qty * l.priceCents;
      orderTotal = orderTotal + lineTotal;
      if (bySku[sku] === undefined) {
        bySku[sku] = 0;
      }
      bySku[sku] = bySku[sku] + l.qty;
    }
    total = total + orderTotal;
    out = out + 'Pedido ' + o.id + ': ' + (orderTotal / 100).toFixed(2) + ' EUR\n';
  }
  out = out + '------------------\n';
  out = out + 'Pedidos validos: ' + count + '\n';
  out = out + 'Total: ' + (total / 100).toFixed(2) + ' EUR\n';
  const skus = Object.keys(bySku).sort();
  if (skus.length > 0) {
    out = out + 'Unidades por SKU:\n';
    for (let k = 0; k < skus.length; k++) {
      out = out + '  ' + skus[k] + ': ' + bySku[skus[k]] + '\n';
    }
  }
  return out;
}
