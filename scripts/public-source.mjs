import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Publish a clean source tree, never repository history or a working directory.
// New top-level components require an explicit review here.
export function publicSourcePath(path) {
  if (/^(api|web)\//.test(path)) {
    if (/(^|\/)(node_modules|data|backups|dist|\.nuxt|\.output|downloads|test-results|playwright-report)(\/|$)/.test(path)) return null;
    if (/(^|\/)\.env(?:\.|$)/.test(path) || /\.(db|sqlite|pem|key)(?:-|$)/.test(path)) return null;
    if (path === 'web/public/install.sh') return null;
    return path;
  }
  if (['.env.example', 'SECURITY-CONSIDERATIONS.md', 'SECURITY.md', 'LICENSE',
    'docs/PROTOCOL.md', 'docs/COMPARISON.md', 'docs/SELF-HOSTING.md', 'docs/HOSTING-POLICY.md', 'docs/DEVELOPMENT.md',
    'scripts/check-permissions.sh', 'scripts/smoke-test.sh'].includes(path)) return path;
  if (path.startsWith('docs/images/')) return path;
  if (path === 'deploy/public-compose.yml') return 'compose.yml';
  if (path === 'deploy/Caddyfile') return 'Caddyfile';
  if (path === 'deploy/public-web.Dockerfile') return 'web/Dockerfile';
  return null;
}

export function exportApplicationSource(repository, output) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: repository, encoding: 'utf8' }).split('\0').filter(Boolean);
  // Dockerfile is intentionally replaced by the portable public build below.
  for (const source of tracked.sort((a, b) => Number(a.startsWith('deploy/')) - Number(b.startsWith('deploy/')))) {
    const target = publicSourcePath(source);
    if (!target) continue;
    const from = join(repository, source);
    if (!lstatSync(from).isFile()) throw new Error(`Public source must be a regular file: ${source}`);
    mkdirSync(dirname(join(output, target)), { recursive: true });
    copyFileSync(from, join(output, target));
  }
}
