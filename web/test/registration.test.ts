import assert from 'node:assert/strict';
import test from 'node:test';
import { ensureRegistration } from '../app/utils/registration.ts';

class MemoryStorage implements Storage {
  private values = new Map<string, string>();

  get length(): number {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('concurrent registration callers create only one account', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const storage = new MemoryStorage();
  let requests = 0;
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    requests++;
    await Promise.resolve();
    return Response.json({ uid: 'user-1', apiKey: 'key-1' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  });

  const identities = await Promise.all([
    ensureRegistration('https://example.com'),
    ensureRegistration('https://example.com'),
    ensureRegistration('https://example.com'),
  ]);

  assert.equal(requests, 1);
  assert.deepEqual(identities, Array(3).fill({ uid: 'user-1', apiKey: 'key-1' }));
  assert.equal(storage.getItem('notecolab-api-key'), 'key-1');
  assert.equal(storage.getItem('notecolab-uid'), 'user-1');
});

test('a failed registration can be retried without storing invalid credentials', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const storage = new MemoryStorage();
  let requests = 0;
  globalThis.localStorage = storage;
  globalThis.fetch = async () => {
    requests++;
    return requests === 1
      ? Response.json({ error: 'Too many registrations' }, { status: 429 })
      : Response.json({ uid: 'user-2', apiKey: 'key-2' });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  });

  await assert.rejects(ensureRegistration('https://example.com'), /Too many registrations/);
  assert.equal(storage.length, 0);
  assert.deepEqual(
    await ensureRegistration('https://example.com'),
    { uid: 'user-2', apiKey: 'key-2' },
  );
  assert.equal(requests, 2);
});
