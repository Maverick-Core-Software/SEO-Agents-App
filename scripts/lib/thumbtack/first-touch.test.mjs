import assert from 'node:assert/strict';
import test from 'node:test';

import { generateFirstTouchReply } from './first-touch.mjs';

test('returns a safe Grizzly first-touch that asks one question', () => {
  const result = generateFirstTouchReply({
    customerName: 'Alex R',
    category: 'Electrician',
    text: 'Need a 50 amp EV charger circuit',
  });
  assert.equal(result.success, true);
  assert.match(result.reply, /Jaime/);
  assert.match(result.reply, /Grizzly/);
  assert.match(result.reply, /469/);
  assert.match(result.reply, /EV charger/i);
  assert.doesNotMatch(result.reply, /housecall|hcp|api|webhook|token/i);
  assert.ok(result.reply.length < 1000);
});

test('still replies when the customer name is missing', () => {
  const result = generateFirstTouchReply({ text: 'Outlet in the kitchen is dead' });
  assert.equal(result.success, true);
  assert.ok(result.reply.startsWith('Hi —'));
  assert.match(result.reply, /outlet/i);
});
