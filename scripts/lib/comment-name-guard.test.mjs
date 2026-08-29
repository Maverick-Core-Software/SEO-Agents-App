import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCommenterName, stripUnknownNames } from './comment-name-guard.mjs';

test('resolveCommenterName reports unknown when Graph omits from (real customers)', () => {
  // Observed live payload for a customer comment on the Grizzly Page.
  const c = { id: '1040829422070286_1564310421740861', message: 'How much would it cost', from: null };
  assert.deepEqual(resolveCommenterName(c, '108252941997164'), { known: false, full: null, first: null });
});

test('resolveCommenterName never treats our own Page as a customer', () => {
  const c = { from: { name: 'Grizzly Electrical Solutions', id: '108252941997164' } };
  assert.equal(resolveCommenterName(c, '108252941997164').known, false);
});

test('resolveCommenterName uses a real name when Graph actually returns one', () => {
  const c = { from: { name: 'Dana Whitfield', id: '999' } };
  assert.deepEqual(resolveCommenterName(c, '108252941997164'), { known: true, full: 'Dana Whitfield', first: 'Dana' });
});

test('stripUnknownNames removes the invented greeting name', () => {
  // The exact reply the agent posted on 2026-07-23 to a from:null comment.
  const r = stripUnknownNames('Hey Sarah, thanks for sharing! Appreciate it.', null);
  assert.equal(r.text, 'Hey, thanks for sharing! Appreciate it.');
  assert.equal(r.stripped, true);
});

test('stripUnknownNames handles the 2026-08-28 panel-upgrade reply', () => {
  const r = stripUnknownNames("Hey Mike, that depends on your panel's condition.", null);
  assert.equal(r.text, "Hey, that depends on your panel's condition.");
});

test('stripUnknownNames removes a bare leading vocative and recapitalizes', () => {
  const r = stripUnknownNames('Mike, that depends on the panel.', null);
  assert.equal(r.text, 'That depends on the panel.');
});

test('stripUnknownNames removes a trailing vocative', () => {
  const r = stripUnknownNames('DM us a photo and I can ballpark it, Sarah!', null);
  assert.equal(r.text, 'DM us a photo and I can ballpark it!');
});

test('stripUnknownNames keeps the one name we genuinely know', () => {
  const r = stripUnknownNames('Hey Dana, appreciate that!', 'Dana');
  assert.equal(r.text, 'Hey Dana, appreciate that!');
  assert.equal(r.stripped, false);
});

test('stripUnknownNames still strips a different name when one is known', () => {
  const r = stripUnknownNames('Hey Sarah, appreciate that!', 'Dana');
  assert.equal(r.text, 'Hey, appreciate that!');
  assert.equal(r.stripped, true);
});

test('stripUnknownNames leaves name-free replies untouched', () => {
  const text = "It depends on your setup — send us a photo and I'll ballpark it.";
  const r = stripUnknownNames(text, null);
  assert.equal(r.text, text);
  assert.equal(r.stripped, false);
});

test('stripUnknownNames keeps the greeting after removing the name', () => {
  // Regression: the leading-vocative rule used to eat the surviving "Hey,".
  assert.equal(stripUnknownNames('Hey, thanks for sharing!', null).text, 'Hey, thanks for sharing!');
});

test('stripUnknownNames does not treat common openers as names', () => {
  for (const text of ['Sure, we can swing by Thursday.', 'Honestly, that panel is due.', 'Nice, glad it held up!']) {
    assert.equal(stripUnknownNames(text, null).text, text);
  }
});

test('stripUnknownNames does not eat legitimate mid-sentence proper nouns', () => {
  const text = 'We cover Rowlett and Garland, so we can swing by this week.';
  assert.equal(stripUnknownNames(text, null).text, text);
});
