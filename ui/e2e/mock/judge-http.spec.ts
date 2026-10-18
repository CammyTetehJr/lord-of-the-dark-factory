import { expect, test, type Page } from '@playwright/test'
import type { FactoryEvent, ProdStatus } from '../../src/api/types.ts'
import { hold, resetButton, rollbackButton } from '../helpers.ts'

const stations = ['scope', 'baseline', 'reproduce', 'fix', 'oracle', 'diff_inspection', 'review', 'deploy']
const bug = { id: 'bug7', title: 'API keys keep working after they expire', body: 'Expired keys still work.' }
const base = { ts: '2026-10-18T10:00:00+00:00', prev_hash: '', hash: '' }
const oldEvents: FactoryEvent[] = [
  { ...base, seq: 1, run_id: 'old-run', type: 'run_started', bug, fixer: 'reference', reproducer: 'dev', stations },
  { ...base, seq: 2, run_id: 'old-run', type: 'station_finished', station: 'scope', outcome: 'escalate', reason: 'Authentication needs a human.', evidence: {} },
  { ...base, seq: 3, run_id: 'old-run', type: 'escalated', station: 'scope', reason: 'Authentication needs a human.' },
  { ...base, seq: 4, run_id: 'old-run', type: 'run_finished', outcome: 'escalated' },
]

async function factory(page: Page, options: { refuseRuns?: boolean; deny?: string } = {}) {
  const events = [...oldEvents]
  const requests: unknown[] = []
  let resets = 0
  let prod: ProdStatus = {
    up: true, url: 'http://localhost:9999', stable: { name: 'stable', commit: 'abc1234', port: 9999, pid: 1 },
    mainline: ['abc1234 fix', 'def1234 original'], history: [{ ts: base.ts, event: 'promoted', commit: 'abc1234', title: 'A promoted fix' }],
  }
  await page.route(/^https?:\/\/[^/]+\/api\//, async (route) => {
    const url = new URL(route.request().url())
    const p = url.pathname
    const headers = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type' }
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers })
    if (options.deny === p) return route.fulfill({ status: 401, headers, json: { detail: 'access code required' } })
    if (p === '/api/events/stream') {
      return route.fulfill({ headers, contentType: 'text/event-stream', body: events.filter((e) => e.seq > Number(url.searchParams.get('since') ?? 0)).map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') })
    }
    let body: unknown
    if (p === '/api/meta') body = { stations, fixers: ['reference', 'rogue:slow_fix'], reproducers: ['dev'], target: { repo: 'target', ref: 'main' } }
    else if (p === '/api/bugs') body = [bug]
    else if (p === '/api/line') body = { paused: false }
    else if (p === '/api/audit/verify') body = { ok: true, message: 'chain intact, all signed by key 10a485cc7585d4c4', events: events.length }
    else if (p === '/api/prod') body = prod
    else if (p === '/api/prod/reset') {
      requests.push(route.request().postDataJSON())
      resets++
      prod = { ...prod, stable: { ...prod.stable!, commit: 'def1234' }, mainline: ['def1234 original'], history: [{ ts: base.ts, event: 'reset', by: 'judge' }] }
      body = { ok: true, message: 'Production restarted from the original code; all seeded bugs are back.', url: prod.url, commit: 'def1234' }
    } else if (p === '/api/runs') {
      if (options.refuseRuns) return route.fulfill({ status: 429, headers, json: { detail: 'The hourly limit is reached. Try again later.' } })
      requests.push(route.request().postDataJSON())
      const run_id = `new-run-${events.length}`
      events.push({ ...base, ts: new Date().toISOString(), seq: events.length + 1, type: 'run_started', run_id, bug, fixer: 'nemotron', reproducer: 'nemotron', stations })
      body = { run_id }
    } else return route.fulfill({ status: 404, headers, json: { detail: 'not found' } })
    return route.fulfill({ headers, json: body })
  })
  return { requests, resetCount: () => resets }
}

test('a fresh visit hides old lanes and escalations, retains live runs across audit polls, and can reveal history', async ({ page }) => {
  await factory(page)
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Show earlier runs' })).toBeVisible()
  await expect(page.getByLabel('Event stream').locator('.rail-h .mono')).toHaveText('seq 4')
  await expect(page.locator('.lane')).toHaveCount(0)
  await expect(page.locator('.qi')).toHaveCount(0)
  await page.getByRole('button', { name: 'Run all (1)', exact: true }).click()
  await expect(page.locator('.lane')).toHaveCount(1)
  await expect(page.locator('.audit-pill')).toContainText('5 events')
  await expect(page.locator('.lane')).toHaveCount(1)
  await page.getByRole('button', { name: 'Show earlier runs' }).click()
  await expect(page.locator('.lane')).toHaveCount(2)
  await expect(page.locator('.qi')).toHaveCount(1)
  await page.getByRole('button', { name: 'Clear board' }).click()
  await expect(page.locator('.lane')).toHaveCount(0)
  await expect(page.locator('.qi')).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('button', { name: 'Show earlier runs' })).toBeVisible()
  await expect(page.getByLabel('Event stream').locator('.rail-h .mono')).toHaveText('seq 5')
  await expect(page.locator('.lane')).toHaveCount(0)
})

test('hold-to-reset uses the HTTP endpoint with judge attribution and refreshes production', async ({ page }) => {
  const server = await factory(page)
  await page.goto('/')
  await hold(page, resetButton(page))
  expect(server.resetCount()).toBe(1)
  expect(server.requests).toEqual([{ by: 'judge', reason: '' }])
  await expect(page.locator('.prod .pill')).toHaveText('PROD def1234')
  await expect(rollbackButton(page)).toBeDisabled()
})

test('a scenario shows the server’s 429 reason instead of claiming it started', async ({ page }) => {
  await factory(page, { refuseRuns: true })
  await page.goto('/')
  await page.locator('[data-scenario="nasty"]').getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('[data-scenario="nasty"] .scenario-error')).toContainText('The hourly limit is reached. Try again later.')
  await expect(page.locator('.lane')).toHaveCount(0)
  await expect(page.locator('[data-scenario="nasty"]')).not.toContainText('accepted')
})

test('an expired access code on a production action replaces the board with the full-page message', async ({ page }) => {
  await factory(page, { deny: '/api/prod/reset' })
  await page.goto('/')
  await hold(page, resetButton(page))
  await expect(page.getByRole('heading', { name: 'This link needs an access code.' })).toBeVisible()
  await expect(page.locator('.gbar')).toHaveCount(0)
})
