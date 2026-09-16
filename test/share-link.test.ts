import assert from 'node:assert/strict';
import test from 'node:test';
import { shareIdFromLink } from '../src/share/shareLink.ts';
import { initialUsernamePromptState, isOfficialServerAlias, migrateOfficialServerUrl } from '../src/types.ts';

test('extracts the exact permission link ID without confusing query or key data', () => {
  assert.equal(
    shareIdFromLink('https://example.com/s/view-link?help=1#secret'),
    'view-link',
  );
  assert.equal(shareIdFromLink(undefined), '');
  assert.equal(shareIdFromLink('not a URL'), '');
});

test('the legacy and current official domains resolve to the same service', () => {
  assert.equal(
    isOfficialServerAlias('https://notecolab.felixmrak.com/path', 'https://notecolab.com'),
    true,
  );
  assert.equal(isOfficialServerAlias('https://self-hosted.example', 'https://notecolab.com'), false);
});

test('only the legacy official setting migrates to the new domain', () => {
  assert.equal(migrateOfficialServerUrl('https://notecolab.felixmrak.com/'), 'https://notecolab.com');
  assert.equal(migrateOfficialServerUrl('https://notes.example.com/'), 'https://notes.example.com/');
});

test('existing identities get the upgrade username prompt while new installs wait for three shares', () => {
  assert.equal(initialUsernamePromptState({ apiKey: 'existing-key' }), 'upgrade');
  assert.equal(initialUsernamePromptState(null), 'after_shares');
  assert.equal(initialUsernamePromptState({ apiKey: 'existing-key', usernamePromptState: 'done' }), 'done');
});
