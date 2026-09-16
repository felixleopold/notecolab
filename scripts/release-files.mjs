import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export const PUBLIC_FILES = [
  '.github',
  '.gitignore',
  'README.md',
  'esbuild.config.mjs',
  'main.js',
  'manifest.json',
  'package-lock.json',
  'package.json',
  'release-approval.json',
  'src',
  'tsconfig.json',
  'versions.json',
];

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function assertFile(path, label) {
  let stat;
  try {
    stat = statSync(path);
  } catch {
    throw new Error(`Missing ${label}: ${path}`);
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`${label} is empty or is not a file: ${path}`);
  }
}

function assertSameFile(left, right, label) {
  assertFile(right, label);
  if (!readFileSync(left).equals(readFileSync(right))) {
    throw new Error(`${label} does not match ${left}`);
  }
}

export function validateRelease({
  root,
  tag,
  channel,
  artifacts,
  submission = false,
}) {
  const releaseRoot = resolve(root);
  const manifestPath = join(releaseRoot, 'manifest.json');
  const versionsPath = join(releaseRoot, 'versions.json');
  const mainPath = join(releaseRoot, 'main.js');
  assertFile(manifestPath, 'manifest.json');
  assertFile(versionsPath, 'versions.json');
  assertFile(mainPath, 'main.js');

  const manifest = readJson(manifestPath);
  if (!VERSION_PATTERN.test(manifest.version ?? '')) {
    throw new Error(`manifest.version must use x.y.z: ${manifest.version ?? '(missing)'}`);
  }
  if (!VERSION_PATTERN.test(manifest.minAppVersion ?? '')) {
    throw new Error(`manifest.minAppVersion must use x.y.z: ${manifest.minAppVersion ?? '(missing)'}`);
  }
  if (!/^[a-z][a-z-]*[a-z]$/.test(manifest.id ?? '') || manifest.id.endsWith('plugin')) {
    throw new Error('manifest.id must use lowercase letters/hyphens and must not end with "plugin"');
  }
  if (manifest.id.includes('obsidian')) {
    throw new Error('manifest.id must not contain "obsidian"');
  }
  for (const field of ['name', 'description', 'author']) {
    if (typeof manifest[field] !== 'string' || manifest[field].trim() === '') {
      throw new Error(`manifest.${field} must be a non-empty string`);
    }
  }
  if (typeof manifest.isDesktopOnly !== 'boolean') {
    throw new Error('manifest.isDesktopOnly must be a boolean');
  }

  const versions = readJson(versionsPath);
  if (versions[manifest.version] !== manifest.minAppVersion) {
    throw new Error(
      `versions.json must map ${manifest.version} to ${manifest.minAppVersion}`,
    );
  }

  const packagePath = join(releaseRoot, 'package.json');
  try {
    const pkg = readJson(packagePath);
    if (pkg.version !== manifest.version) {
      throw new Error(
        `package.json version ${pkg.version} does not match manifest.version ${manifest.version}`,
      );
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  if (tag) {
    const expectedTag = channel === 'store' ? manifest.version : `v${manifest.version}`;
    if (tag !== expectedTag) {
      throw new Error(
        `${channel} tag ${tag} must exactly match ${expectedTag}`,
      );
    }
  }

  const stylesPath = join(releaseRoot, 'styles.css');
  let hasStyles = false;
  try {
    assertFile(stylesPath, 'styles.css');
    hasStyles = true;
  } catch (error) {
    if (!String(error.message).startsWith('Missing styles.css:')) throw error;
  }

  if (artifacts) {
    const artifactRoot = resolve(artifacts);
    assertSameFile(manifestPath, join(artifactRoot, 'manifest.json'), 'release manifest.json');
    assertSameFile(versionsPath, join(artifactRoot, 'versions.json'), 'release versions.json');
    assertSameFile(mainPath, join(artifactRoot, 'main.js'), 'release main.js');
    if (hasStyles) {
      assertSameFile(stylesPath, join(artifactRoot, 'styles.css'), 'release styles.css');
    }
    const expected = new Set([
      'main.js',
      'manifest.json',
      'versions.json',
      ...(hasStyles ? ['styles.css'] : []),
    ]);
    const actual = readdirSync(artifactRoot);
    const unexpected = actual.filter((name) => !expected.has(name));
    if (actual.length !== expected.size || unexpected.length > 0) {
      throw new Error(
        `release artifact set is incomplete or unexpected: ${actual.sort().join(', ')}`,
      );
    }
  }

  if (submission) {
    const approvalPath = join(releaseRoot, 'release-approval.json');
    const licensePath = join(releaseRoot, 'LICENSE');
    assertFile(approvalPath, 'release-approval.json');
    assertFile(licensePath, 'LICENSE');
    const approval = readJson(approvalPath);
    if (
      approval.name !== manifest.name
      || approval.id !== manifest.id
      || typeof approval.license !== 'string'
      || approval.license.trim() === ''
    ) {
      throw new Error(
        'release-approval.json must explicitly approve the current manifest name, id, and license',
      );
    }
  }

  return {
    version: manifest.version,
    files: ['main.js', 'manifest.json', 'versions.json', ...(hasStyles ? ['styles.css'] : [])],
  };
}

export function assertSafeOutput(output, pluginRoot) {
  const target = resolve(output);
  const root = resolve(pluginRoot);
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || basename(target) === '') {
    throw new Error(`Output must be a directory inside ${root}`);
  }
  return target;
}
