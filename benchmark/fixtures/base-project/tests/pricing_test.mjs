import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDiscount, computeTax, finalPrice } from '../src/pricing.js';

test('applyDiscount aplica porcentaje y redondea', () => {
  assert.equal(applyDiscount(1000, 10), 900);
  assert.equal(applyDiscount(999, 15), 849);
});

test('computeTax general y reducido', () => {
  assert.equal(computeTax(1000), 210);
  assert.equal(computeTax(1000, 'reducido'), 100);
});

test('finalPrice aplica descuento y despues impuesto', () => {
  assert.equal(finalPrice({ sku: 'abc-1234', priceCents: 1000, taxCategory: 'general' }, 10), 1089);
});
