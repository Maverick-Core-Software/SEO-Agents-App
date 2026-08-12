import assert from 'node:assert/strict';
import test from 'node:test';
import {
  derivePostServiceType,
  isManifestSelectionCompatible,
  serviceSlug,
} from './photo-selection.mjs';

test('specific service terms win over generic panel wording', () => {
  assert.equal(derivePostServiceType({ service: 'Generator Installation', topic: 'generator panel' }), 'generator');
  assert.equal(derivePostServiceType({ service: 'Panel Upgrades' }), 'panel');
});

test('a photo must have an audited, same-service manifest entry', () => {
  const post = { service: 'Panel Upgrades' };
  const manifest = [{
    postDate: '2026-08-09',
    postService: 'Panel Upgrades',
    postServiceType: 'panel',
    photoPath: 'E:/Media/Grizzly/Curated/2026-08-09-panel-upgrades.jpg',
    photoServiceType: 'panel',
  }];

  assert.equal(isManifestSelectionCompatible({
    date: '2026-08-09', service: post.service,
    photoPath: 'e:\\media\\grizzly\\curated\\2026-08-09-panel-upgrades.jpg', manifest,
  }).ok, true);
  assert.equal(isManifestSelectionCompatible({
    date: '2026-08-09', service: post.service,
    photoPath: 'E:/Media/Grizzly/Curated/2026-08-09-panel-upgrades.jpg',
    manifest: [{ ...manifest[0], photoServiceType: 'generator' }],
  }).ok, false);
  assert.equal(isManifestSelectionCompatible({
    date: '2026-08-09', service: post.service,
    photoPath: 'E:/Media/Grizzly/Curated/2026-08-09-panel-upgrades.jpg', manifest: [],
  }).ok, false);
});

assert.equal(serviceSlug('Panel Upgrades'), 'panel-upgrades');
console.log('ok photo-selection');
