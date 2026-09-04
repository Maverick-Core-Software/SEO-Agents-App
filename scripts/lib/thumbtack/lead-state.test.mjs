import assert from 'node:assert/strict';
import test from 'node:test';

import { extractCustomerLeadEvent, splitThumbtackAgentReply } from './lead-state.mjs';

test('accepts complete customer MessageCreatedV4 events', () => {
  const record = {
    id: 'a'.repeat(64),
    payload: {
      event: { eventType: 'MessageCreatedV4' },
      data: {
        from: 'Customer', messageID: 'msg-1', negotiationID: 'neg-1', text: 'I need an EV charger',
        customer: { displayName: 'Jamie Example' },
      },
    },
  };
  assert.deepEqual(extractCustomerLeadEvent(record), {
    kind: 'customer-message',
    operationId: `thumbtack-${record.id}`,
    negotiationID: 'neg-1',
    messageID: 'msg-1',
    customerName: 'Jamie Example',
    category: '',
    text: 'I need an EV charger',
  });
  assert.equal(extractCustomerLeadEvent({
    ...record,
    payload: { ...record.payload, data: { ...record.payload.data, from: 'business' } },
  }), null);
});

test('classifies NegotiationCreatedV4 as a new lead', () => {
  const record = {
    id: 'b'.repeat(64),
    eventType: 'NegotiationCreatedV4',
    payload: {
      event: { eventType: 'NegotiationCreatedV4' },
      data: {
        negotiationID: 'neg-9',
        customer: { firstName: 'Alex', lastName: 'R' },
        request: {
          description: 'Need a new circuit for an EV charger',
          category: { name: 'Electrician' },
          details: [{ question: 'Amperage', answer: '50 amp' }],
        },
      },
    },
  };
  const lead = extractCustomerLeadEvent(record);
  assert.equal(lead.kind, 'new-lead');
  assert.equal(lead.negotiationID, 'neg-9');
  assert.equal(lead.customerName, 'Alex R');
  assert.equal(lead.category, 'Electrician');
  assert.match(lead.text, /50 amp/);
});

test('strips estimate-ready blocks from visible replies', () => {
  assert.deepEqual(
    splitThumbtackAgentReply('Great — what amperage do you need? [THUMBTACK_ESTIMATE_READY]{"scope":"x"}[/THUMBTACK_ESTIMATE_READY]'),
    { visibleReply: 'Great — what amperage do you need?', estimateReady: { scope: 'x' }, malformed: false },
  );
});
