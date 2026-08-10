import assert from 'node:assert/strict';
import test from 'node:test';
import { findImageEmbeds } from '../src/share/imageEmbeds.ts';

test('findImageEmbeds accepts sized images inside and outside Markdown tables', () => {
  const text = [
    '![[plain.png]]',
    '![[sized.webp|120]]',
    '| Preview | ![[Raphs Reptiles – Farbvorschau Weiß.svg\\|52]] |',
  ].join('\n');

  assert.deepEqual(findImageEmbeds(text), [
    'plain.png',
    'sized.webp',
    'Raphs Reptiles – Farbvorschau Weiß.svg',
  ]);
});

test('findImageEmbeds ignores non-image embeds and removes duplicates', () => {
  assert.deepEqual(
    findImageEmbeds('![[note.md\\|52]] ![[image.svg]] ![[image.svg\\|52]]'),
    ['image.svg'],
  );
});
