import type { AuditResult, Bug, FactoryEvent, LineState, Meta, ReplayResult, RunRequest } from './types'

/** Everything the UI needs from the factory. `http` talks to `factory serve`; `mock` simulates it in the browser. */
export interface FactorySource {
  kind: 'http' | 'mock'
  meta(): Promise<Meta>
  bugs(): Promise<Bug[]>
  startRun(req: RunRequest): Promise<{ run_id: string }>
  /** Calls onEvent for every event with seq > since, then live. Returns an unsubscribe function. */
  subscribe(since: number, onEvent: (e: FactoryEvent) => void, onStatus?: (s: StreamStatus) => void): () => void
  line(): Promise<LineState>
  pause(by: string, reason: string): Promise<LineState>
  resume(by: string, reason: string): Promise<LineState>
  verify(): Promise<AuditResult>
  artifact(runId: string, name: 'fix.diff' | 'repro_test.py'): Promise<string | null>
  /** Re-runs every deterministic gate from the signed record (5 to 10 s on the real server). */
  replay(runId: string): Promise<ReplayResult>
  pubkey(): Promise<string>
}

export type StreamStatus = 'connecting' | 'open' | 'retrying'

export const API_URL: string = import.meta.env.VITE_API_URL ?? 'http://127.0.0.1:8100'

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API_URL + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`${init?.method ?? 'GET'} ${path} failed (${res.status})${detail ? `: ${detail}` : ''}`)
  }
  return res.json() as Promise<T>
}

export const httpSource: FactorySource = {
  kind: 'http',
  meta: () => json<Meta>('/api/meta'),
  bugs: () => json<Bug[]>('/api/bugs'),
  startRun: (req) => json('/api/runs', { method: 'POST', body: JSON.stringify(req) }),
  line: () => json<LineState>('/api/line'),
  pause: (by, reason) => json('/api/line/pause', { method: 'POST', body: JSON.stringify({ by, reason }) }),
  resume: (by, reason) => json('/api/line/resume', { method: 'POST', body: JSON.stringify({ by, reason }) }),
  verify: () => json<AuditResult>('/api/audit/verify'),
  replay: (runId) => json<ReplayResult>(`/api/runs/${encodeURIComponent(runId)}/replay`, { method: 'POST' }),
  async pubkey() {
    const res = await fetch(`${API_URL}/api/audit/pubkey`)
    if (!res.ok) throw new Error(`GET /api/audit/pubkey failed (${res.status})`)
    return res.text()
  },
  async artifact(runId, name) {
    const res = await fetch(`${API_URL}/api/runs/${encodeURIComponent(runId)}/artifacts/${name}`)
    return res.ok ? res.text() : null
  },
  subscribe(since, onEvent, onStatus) {
    // The server reads `since` from the query, not Last-Event-ID, so reconnect by hand with the latest seq.
    let last = since
    let es: EventSource | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let closed = false
    const open = () => {
      onStatus?.('connecting')
      es = new EventSource(`${API_URL}/api/events/stream?since=${last}`)
      es.onopen = () => onStatus?.('open')
      es.onmessage = (m) => {
        const e = JSON.parse(m.data) as FactoryEvent
        if (e.seq > last) last = e.seq
        onEvent(e)
      }
      es.onerror = () => {
        es?.close()
        if (closed) return
        onStatus?.('retrying')
        timer = setTimeout(open, 1500)
      }
    }
    open()
    return () => {
      closed = true
      clearTimeout(timer)
      es?.close()
    }
  },
}
