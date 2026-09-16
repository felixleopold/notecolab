import assert from 'node:assert/strict';
import { register } from 'node:module';
import test from 'node:test';

register('./folder-test-loader.mjs', import.meta.url);

const { TFile, TFolder } = await import('obsidian');
const { encrypt, encryptBinary } = await import('../src/crypto/crypto.ts');
const { importFolderShare } = await import('../src/share/folderImport.ts');

test('an existing imported note retries failed images before marking the folder entry complete', async () => {
  const key = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const root = new TFolder('Shared Folders/Project');
  const noteFile = new TFile('Shared Folders/Project/Note.md');
  const files = new Map([[noteFile.path, noteFile]]);
  const contents = new Map([[noteFile.path, '---\ncolab_share_id: canonical-room\n---\n![[image.png]]']]);
  const cache = new Map([[noteFile.path, {
    colab_share_id: 'canonical-room',
    colab_link_id: 'permission-link',
    colab_link: `https://notes.example/s/permission-link#${key}`,
  }]]);
  let createdNotes = 0;
  const app = {
    vault: {
      getMarkdownFiles: () => [noteFile],
      getAbstractFileByPath: path => path === root.path ? root : files.get(path) || null,
      read: async file => contents.get(file.path),
      async create() { createdNotes++; },
      async createFolder() {},
      async createBinary(path) { files.set(path, new TFile(path)); },
    },
    metadataCache: {
      getFileCache: file => ({ frontmatter: cache.get(file.path) }),
      getFirstLinkpathDest: name => files.get(`Shared Folders/Project/${name}`) || null,
    },
  };
  let imageRequests = 0;
  const encryptedData = await encryptBinary(new Uint8Array([1, 2, 3]).buffer, key);
  const loaded = {
    manifestUrl: `https://notes.example/s/folder#${key}`,
    manifest: {
      kind: 'notecolab-folder',
      version: 1,
      name: 'Project',
      publishedAt: '',
      entries: [{ path: 'Note.md', shareUrl: `https://notes.example/s/permission-link#${key}` }],
    },
    api: {
      async getNoteContent() { return { roomId: 'canonical-room', accessMode: 'read_only' }; },
      async getImage() {
        imageRequests++;
        return imageRequests === 1 ? null : { encryptedData, mimeType: 'image/png' };
      },
    },
  };
  const options = {
    settings: { serverUrl: 'https://notes.example', trustedShareHosts: [] },
    targetRoot: root.path,
  };

  const first = await importFolderShare(app, loaded, options);
  assert.equal(first.failed.length, 1);
  assert.deepEqual(first.completedPaths, []);

  const retry = await importFolderShare(app, loaded, options);
  assert.equal(retry.failed.length, 0);
  assert.equal(retry.skipped, 1);
  assert.deepEqual(retry.completedPaths, ['Note.md']);
  assert.ok(files.has('Shared Folders/Project/image.png'));
  assert.equal(createdNotes, 0, 'the existing Markdown file was never overwritten or duplicated');
  cache.get(noteFile.path).colab_link = `https://different.example/s/permission-link#${key}`;
  loaded.api.getNoteContent = async () => ({ roomId: 'canonical-room', accessMode: 'read_only', encryptedContent: await encrypt('Different origin', key) });
  const otherOrigin = await importFolderShare(app, loaded, options);
  assert.equal(otherOrigin.failed.length, 0);
  assert.equal(createdNotes, 1, 'matching IDs on another origin are a different note');
});
