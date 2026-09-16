import assert from 'node:assert/strict';
import test from 'node:test';
import { publicSourcePath } from '../scripts/public-source.mjs';

test('public export includes application source but excludes runtime data and private deployment', () => {
  assert.equal(publicSourcePath('api/src/routes/auth.ts'), 'api/src/routes/auth.ts');
  assert.equal(publicSourcePath('web/app/pages/index.vue'), 'web/app/pages/index.vue');
  assert.equal(publicSourcePath('deploy/public-compose.yml'), 'compose.yml');
  for (const path of ['.env', 'api/.env.production', 'api/data/notecolab.db', 'web/.output/server/index.mjs',
    'web/node_modules/pkg/index.js', 'web/public/downloads/main.js', 'AGENTS.md', 'deploy.sh',
    'docker-compose.yml', '.github/workflows/deploy.yml', 'docs/CHANGES-2026-07-08.md']) {
    assert.equal(publicSourcePath(path), null, path);
  }
});
