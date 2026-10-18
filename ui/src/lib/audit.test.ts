import { describe, expect, it } from 'vitest'
import { auditLabel } from './audit'

describe('auditLabel', () => {
  it('shortens an intact, signed chain and keeps the full sentence as the tooltip', () => {
    const message = 'chain intact, 1347 events, all signed by key 10a485cc7585d4c4'
    expect(auditLabel({ ok: true, message, events: 1347 })).toEqual({ text: '✓ Chain intact · 1,347 events · signed', key: '10a485cc', title: message })
  })

  it('names the broken line and a short cause for every server message', () => {
    const cases: [string, string][] = [
      ['line 43: content was modified (hash mismatch)', '✗ Broken at line 43: content modified'],
      ['line 7: prev_hash does not match line 6 (entry removed, inserted or reordered)', '✗ Broken at line 7: entry removed, inserted or reordered'],
      ["line 9: signature invalid (not written by this factory's key)", '✗ Broken at line 9: signature invalid'],
      ['line 2: entry is not signed', '✗ Broken at line 2: entry not signed'],
    ]
    for (const [message, text] of cases) expect(auditLabel({ ok: false, message, events: 50 }).text).toBe(text)
  })

  it('handles no events and the first check', () => {
    expect(auditLabel({ ok: true, message: 'no events yet', events: 0 }).text).toBe('✓ No events yet')
    expect(auditLabel(null).text).toBe('Checking chain…')
  })
})
