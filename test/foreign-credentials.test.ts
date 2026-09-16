import assert from 'node:assert/strict';
import test from 'node:test';
import { requestHeaders, websocketCredentials } from '../src/api/credentials.ts';

const HOME_CREDENTIAL = 'sentinel-home-server-credential';

test('foreign REST requests omit the home-server credential', () => {
  const headers = requestHeaders(HOME_CREDENTIAL, false);
  assert.equal(headers.Authorization, undefined);
  assert.equal(JSON.stringify(headers).includes(HOME_CREDENTIAL), false);
});

test('foreign WebSocket parameters omit the home-server credential', () => {
  const params = {
    ...websocketCredentials(HOME_CREDENTIAL, false),
    link: 'foreign-link',
    rt: 'key-derived-room-token',
  };
  const url = new URL('wss://foreign.example/ws/yjs/room');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  assert.equal(url.searchParams.has('token'), false);
  assert.equal(url.toString().includes(HOME_CREDENTIAL), false);
});
