import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/legacy/report.js';

test('buildReport ignora cancelados y suma pagados', () => {
  const out = buildReport([
    { id: 1, status: 'paid', lines: [{ sku: 'abc-1234', qty: 2, priceCents: 500 }] },
    { id: 2, status: 'cancelled', lines: [{ sku: 'abc-1234', qty: 9, priceCents: 500 }] },
  ]);
  assert.match(out, /Pedidos validos: 1/);
  assert.match(out, /Total: 10\.00 EUR/);
});
