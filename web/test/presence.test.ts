import assert from 'node:assert/strict'
import test from 'node:test'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { parsePresence, presenceLabel, trackPresence, type PresenceRoster } from '../app/utils/presence.ts'

test('labels include self only when present and reject malformed rosters', () => {
  const self = { id: 'self', name: 'Felix', client: 'web' as const }
  const other = { id: 'other', name: 'Guest', client: 'obsidian' as const }
  assert.equal(presenceLabel({ selfId: 'self', participants: [self] }), 'Only you here')
  assert.equal(presenceLabel({ selfId: 'self', participants: [self, other] }), 'You + 1 other')
  assert.equal(presenceLabel({ selfId: 'self', participants: [other] }), '1 person here')
  assert.equal(parsePresence({ selfId: 'self', participants: [{ ...other, client: 'spoof' }] }), null)
})

test('foreground reports leave sync connected, reject peer rosters, and clean up', () => {
  let focused = true
  const browser = new EventTarget()
  const doc = Object.assign(new EventTarget(), { visibilityState: 'visible', hasFocus: () => focused })
  Object.defineProperty(globalThis, 'window', { value: browser, configurable: true })
  Object.defineProperty(globalThis, 'document', { value: doc, configurable: true })
  const ydoc = new Y.Doc()
  const provider = new WebsocketProvider('ws://localhost', 'test', ydoc, { connect: false, disableBc: true })
  const messages: unknown[] = []
  provider.wsconnected = true
  provider.ws = { readyState: 1, send(data: Uint8Array) {
    const decoder = decoding.createDecoder(data)
    assert.equal(decoding.readVarUint(decoder), 4)
    messages.push(JSON.parse(decoding.readVarString(decoder)))
  } } as WebSocket
  let roster: PresenceRoster | null = null
  const stop = trackPresence(provider, (value) => { roster = value })
  try {
    assert.deepEqual(messages.at(-1), { active: true, client: 'web' })
    focused = false
    browser.dispatchEvent(new Event('blur'))
    assert.deepEqual(messages.at(-1), { active: false, client: 'web' })
    focused = true
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    assert.deepEqual(messages.at(-1), { active: false, client: 'web' })
    assert.equal(provider.wsconnected, true)
    const snapshot = { selfId: 'self', participants: [] }
    const deliver = (fromSocket: boolean) => {
      const encoded = encoding.createEncoder()
      encoding.writeVarString(encoded, JSON.stringify(snapshot))
      provider.messageHandlers[4]!(encoding.createEncoder(), decoding.createDecoder(encoding.toUint8Array(encoded)), provider, fromSocket, 4)
    }
    deliver(false)
    assert.equal(roster, null)
    deliver(true)
    assert.deepEqual(roster, snapshot)
    provider.emit('status', [{ status: 'disconnected' }])
    assert.equal(roster, null)
  } finally {
    stop()
    const count = messages.length
    browser.dispatchEvent(new Event('focus'))
    assert.equal(messages.length, count)
    provider.ws = null
    provider.wsconnected = false
    provider.destroy()
    ydoc.destroy()
    Reflect.deleteProperty(globalThis, 'window')
    Reflect.deleteProperty(globalThis, 'document')
  }
})
