#!/usr/bin/env node
import { validateRelease } from './release-files.mjs';

const args = process.argv.slice(2);
const value = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

const channel = args.includes('--store') ? 'store' : 'private';
const result = validateRelease({
  root: value('--root') ?? process.cwd(),
  tag: value('--tag'),
  channel,
  artifacts: value('--artifacts'),
  submission: args.includes('--submission'),
});

console.log(
  `Validated ${channel} plugin release ${result.version}: ${result.files.join(', ')}`,
);
