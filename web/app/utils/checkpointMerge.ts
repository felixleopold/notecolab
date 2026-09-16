import * as Y from 'yjs'

/** Independent legacy seeds contain the same text under different Yjs identities. */
export function mergeDeviceCheckpoint(document: Y.Doc, update: Uint8Array): void {
  const device = new Y.Doc()
  try {
    Y.applyUpdate(device, update)
    const serverVector = Y.decodeStateVector(Y.encodeStateVector(document))
    const deviceVector = Y.decodeStateVector(Y.encodeStateVector(device))
    const sharesHistory = [...deviceVector.keys()].some(client => serverVector.has(client))
    if (serverVector.size === 0 || sharesHistory) {
      Y.applyUpdate(document, update)
      return
    }
    if (deviceVector.size === 0) return
    const text = document.getText('content')
    const serverBody = text.toString()
    const deviceBody = device.getText('content').toString()
    if (serverBody === deviceBody) return
    // Without common history there is no safe deletion inference. Preserve both
    // versions for review instead of concatenating duplicate CRDT seed strings.
    const recovered = `${deviceBody}\n\n<<<<<<< NoteColab recovered server snapshot\n${serverBody}\n>>>>>>>`
    document.transact(() => {
      text.delete(0, text.length)
      text.insert(0, recovered)
    })
  } finally {
    device.destroy()
  }
}


/** Give simultaneous first loads the same immutable baseline, then edit with each peer's own ID. */
export async function seedServerSnapshot(document: Y.Doc, body: string, roomId: string, version: number): Promise<void> {
  if (!body) return
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify(['notecolab-seed-v1', roomId, version, body]),
  )))
  const seed = new Y.Doc()
  try {
    seed.clientID = bytes.slice(0, 6).reduce((value, byte) => value * 256 + byte, 0)
    seed.getText('content').insert(0, body)
    Y.applyUpdate(document, Y.encodeStateAsUpdate(seed))
  } finally { seed.destroy() }
}

export async function initializeCollaborationDocument(
  document: Y.Doc,
  options: {
    body: string
    roomId: string
    version: number
    serverUpdate?: Uint8Array | null
    deviceUpdate?: Uint8Array | null
    editable: boolean
  },
): Promise<{ restoredServerCrdt: boolean, invalidDeviceCheckpoint: boolean }> {
  let restoredServerCrdt = false
  let invalidDeviceCheckpoint = false
  if (options.serverUpdate) {
    try {
      Y.applyUpdate(document, options.serverUpdate)
      restoredServerCrdt = true
    } catch {
      // A malformed encrypted checkpoint falls back to the authoritative body.
    }
  }
  if (!restoredServerCrdt) {
    await seedServerSnapshot(document, options.body, options.roomId, options.version)
  }
  if (options.editable && options.deviceUpdate) {
    try {
      mergeDeviceCheckpoint(document, options.deviceUpdate)
    } catch {
      invalidDeviceCheckpoint = true
    }
  }
  return { restoredServerCrdt, invalidDeviceCheckpoint }
}

/** Apply a newer authoritative snapshot locally without ever creating a server write. */
export function refreshReadOnlySnapshot(
  document: Y.Doc,
  body: string,
  serverUpdate?: Uint8Array | null,
  origin?: unknown,
): void {
  if (serverUpdate) {
    const snapshot = new Y.Doc()
    try {
      Y.applyUpdate(snapshot, serverUpdate)
      const currentVector = Y.decodeStateVector(Y.encodeStateVector(document))
      const snapshotVector = Y.decodeStateVector(Y.encodeStateVector(snapshot))
      const sharesHistory = [...snapshotVector.keys()].some(client => currentVector.has(client))
      if (currentVector.size === 0 || sharesHistory) {
        Y.applyUpdate(document, serverUpdate, origin)
        // The current document may already contain causally newer live edits
        // than the REST response. A compatible CRDT update can only add its
        // missing history, so its merged text is newer than the response body.
        return
      }
    } catch {
      // Fall through to the decrypted body when the checkpoint is malformed.
    } finally {
      snapshot.destroy()
    }
  }

  const text = document.getText('content')
  if (text.toString() === body) return
  document.transact(() => {
    text.delete(0, text.length)
    if (body) text.insert(0, body)
  }, origin)
}
