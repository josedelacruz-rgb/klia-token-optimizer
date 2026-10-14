import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Cart } from '../src/cart.js';

const P1 = { sku: 'abc-1234', priceCents: 1000, taxCategory: 'general' };
const P2 = { sku: 'XYZ-0001', priceCents: 500, taxCategory: 'reducido' };

test('add acumula cantidades por SKU normalizado', () => {
  const c = new Cart();
  c.add(P1, 2);
  c.add({ ...P1, sku: ' ABC-1234 ' }, 1);
  assert.equal(c.count(), 3);
});

test('total sin descuento', () => {
  const c = new Cart();
  c.add(P1, 1);
  c.add(P2, 2);
  // 1000 + 21% = 1210 ; 500 + 10% = 550 x2 = 1100
  assert.equal(c.total(), 2300);
});
