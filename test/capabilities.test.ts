import assert from 'node:assert/strict';
import test from 'node:test';
import { deriveRoomToken, deriveWriteCapability } from '../src/crypto/crypto.ts';

test('room and REST-write capabilities are deterministic and domain-separated', async () => {
  const noteKey = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const roomId = '0123456789abcdef0123456789abcdef';
  const [roomToken, roomTokenAgain, writeToken] = await Promise.all([
    deriveRoomToken(noteKey, roomId),
    deriveRoomToken(noteKey, roomId),
    deriveWriteCapability(noteKey, roomId),
  ]);

  assert.equal(roomToken, roomTokenAgain);
  assert.notEqual(roomToken, writeToken);
  assert.match(roomToken, /^[A-Za-z0-9_-]{43}$/);
  assert.match(writeToken, /^[A-Za-z0-9_-]{43}$/);
});
