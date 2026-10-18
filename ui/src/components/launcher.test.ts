import { describe, expect, it } from 'vitest'
import { buildRequest, prodHasFixFor } from './Launcher'

describe('buildRequest', () => {
  it('keeps Dev on a free branch deploy', () => {
    expect(buildRequest('dev', 'bug2')).toEqual({ bug_id: 'bug2', fixer: 'reference', reproducer: 'dev', classifier: 'none', reviewer: 'none', deploy: 'branch' })
  })
  it('sends slow_fix through the canary even in Dev mode', () => {
    expect(buildRequest('dev', 'bug1', 'rogue:slow_fix').deploy).toBe('canary')
    expect(buildRequest('live', 'bug1', 'rogue:slow_fix').deploy).toBe('canary')
  })
  it('respects an explicit branch choice', () => {
    expect(buildRequest('dev', 'bug1', 'rogue:slow_fix', 'branch').deploy).toBe('branch')
  })
  it('leaves Live roles to the server defaults', () => {
    expect(buildRequest('live', 'bug3')).toEqual({ bug_id: 'bug3' })
  })
})

describe('prodHasFixFor', () => {
  const bug = { id: 'bug1', title: 'Invoice list shows the same invoice on two pages', body: '' }
  const prod = (history: object[]) => ({ up: true, url: null, stable: null, mainline: [], history }) as never
  it('sees a promoted fix that was not reverted', () => {
    expect(prodHasFixFor(prod([{ ts: '', event: 'promoted', title: bug.title }]), bug)).toBe(true)
  })
  it('ignores a reverted fix', () => {
    expect(prodHasFixFor(prod([{ ts: '', event: 'promoted', title: bug.title, reverted: true }]), bug)).toBe(false)
  })
})
