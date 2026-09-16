import assert from 'node:assert/strict';
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { validateRelease } from '../scripts/release-files.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'notecolab-release-'));
  writeFileSync(join(root, 'main.js'), 'module.exports = {};\n');
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    id: 'notecolab',
    name: 'NoteColab',
    version: '1.25.1',
    minAppVersion: '1.4.16',
    description: 'Encrypted note sharing and live collaboration',
    author: 'Felix Mrak',
    isDesktopOnly: false,
  }));
  writeFileSync(join(root, 'versions.json'), JSON.stringify({
    '1.25.1': '1.4.16',
  }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    version: '1.25.1',
  }));
  return root;
}

test('store and private channels require their exact tag formats', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true }));

  validateRelease({ root, tag: '1.25.1', channel: 'store' });
  validateRelease({ root, tag: 'v1.25.1', channel: 'private' });
  assert.throws(
    () => validateRelease({ root, tag: 'v1.25.1', channel: 'store' }),
    /store tag v1\.25\.1 must exactly match 1\.25\.1/,
  );
});

test('validation catches versions and artifact drift', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true }));

  writeFileSync(join(root, 'versions.json'), '{}');
  assert.throws(
    () => validateRelease({ root, channel: 'store' }),
    /versions\.json must map 1\.25\.1 to 1\.4\.16/,
  );

  writeFileSync(join(root, 'versions.json'), JSON.stringify({
    '1.25.1': '1.4.16',
  }));
  const artifacts = join(root, 'artifacts');
  mkdirSync(artifacts);
  for (const file of ['main.js', 'manifest.json', 'versions.json']) {
    cpSync(join(root, file), join(artifacts, file));
  }
  writeFileSync(join(artifacts, 'main.js'), 'drift\n');
  assert.throws(
    () => validateRelease({ root, artifacts, channel: 'store' }),
    /release main\.js does not match/,
  );
});

test('submission validation requires explicit identity and license approval', (t) => {
  const root = fixture();
  t.after(() => rmSync(root, { recursive: true }));

  assert.throws(
    () => validateRelease({ root, channel: 'store', submission: true }),
    /Missing release-approval\.json/,
  );

  writeFileSync(join(root, 'LICENSE'), 'license text\n');
  writeFileSync(join(root, 'release-approval.json'), JSON.stringify({
    name: 'NoteColab',
    id: 'notecolab',
    license: 'MIT',
  }));
  validateRelease({ root, channel: 'store', submission: true });
});
