import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { WebsocketProvider } from 'y-websocket'

export interface PresenceRoster {
  selfId: string
  participants: { id: string; name: string; client: 'web' | 'obsidian' }[]
}

export function parsePresence(value: unknown): PresenceRoster | null {
  if (!value || typeof value !== 'object' || !('selfId' in value) || typeof value.selfId !== 'string'
    || !('participants' in value) || !Array.isArray(value.participants)) return null
  const participants: PresenceRoster['participants'] = []
  const entries: unknown[] = value.participants
  for (const participant of entries) {
    if (!participant || typeof participant !== 'object' || !('id' in participant) || typeof participant.id !== 'string'
      || !('name' in participant) || typeof participant.name !== 'string' || !('client' in participant)
      || (participant.client !== 'web' && participant.client !== 'obsidian')) return null
    participants.push({ id: participant.id, name: participant.name, client: participant.client })
  }
  return { selfId: value.selfId, participants }
}

export function presenceLabel(roster: PresenceRoster): string {
  const here = roster.participants.some(({ id }) => id === roster.selfId)
  const others = roster.participants.length - Number(here)
  if (here) return others ? `You + ${others} ${others === 1 ? 'other' : 'others'}` : 'Only you here'
  return others ? `${others} ${others === 1 ? 'person' : 'people'} here` : 'No one here'
}

export function trackPresence(provider: WebsocketProvider, update: (roster: PresenceRoster | null) => void) {
  const publish = (active = document.visibilityState === 'visible' && document.hasFocus()) => {
    if (!provider.wsconnected || provider.ws?.readyState !== 1) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, 4)
    encoding.writeVarString(encoder, JSON.stringify({ active, client: 'web' }))
    provider.ws.send(encoding.toUint8Array(encoder))
  }
  const onForeground = () => publish()
  const onPageHide = () => publish(false)
  const onStatus = ({ status }: { status: string }) => {
    update(null)
    if (status === 'connected') publish()
  }
  provider.messageHandlers[4] = (_encoder, decoder, _provider, fromSocket) => {
    // BroadcastChannel peers cannot supply an authenticated server roster.
    if (!fromSocket || !provider.wsconnected) return
    try { update(parsePresence(JSON.parse(decoding.readVarString(decoder)))) } catch { update(null) }
  }
  provider.on('status', onStatus)
  window.addEventListener('focus', onForeground)
  window.addEventListener('blur', onForeground)
  window.addEventListener('pageshow', onForeground)
  window.addEventListener('pagehide', onPageHide)
  document.addEventListener('visibilitychange', onForeground)
  const heartbeat = setInterval(onForeground, 20_000)
  publish()
  return () => {
    publish(false)
    clearInterval(heartbeat)
    provider.off('status', onStatus)
    window.removeEventListener('focus', onForeground)
    window.removeEventListener('blur', onForeground)
    window.removeEventListener('pageshow', onForeground)
    window.removeEventListener('pagehide', onPageHide)
    document.removeEventListener('visibilitychange', onForeground)
    delete provider.messageHandlers[4]
    update(null)
  }
}
