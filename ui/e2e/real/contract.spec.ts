// Contract test: the demo beats against a running `factory serve`, in Dev mode (free, no API key).
// It catches the backend changing shape under the UI. Needs:
//   .venv/bin/factory serve        (FACTORY_URL, default http://127.0.0.1:8100)
// The audit test edits runs/events.jsonl and restores it byte for byte (E2E_RUNS_DIR, default ../runs).
// Tests run in order and share the server: the line, the log and production.
import { expect, test, type Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { auditPill, cell, FACTORY_URL, finished, holdAndon, inspect, inspector, lane, openBoard, runAll, runOne, setMode } from '../helpers.ts'

const RUNS_DIR = process.env.E2E_RUNS_DIR ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../runs')
const BUG1_TITLE = 'Invoice list shows the same invoice on two pages'

test.describe.configure({ mode: 'serial' })

async function api<T>(p: string, init?: RequestInit): Promise<T> {
  const res = await fetch(FACTORY_URL + p, { ...init, headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${p} → ${res.status}`)
  return res.json() as Promise<T>
}

type History = { event: string; title?: string; reverted?: boolean }[]

/** slow_fix needs a production without the honest bug1 fix: roll back until it is gone. */
async function productionWithoutBug1Fix() {
  await api('/api/prod/start', { method: 'POST' })
  for (let i = 0; i < 6; i++) {
    const { history } = await api<{ history: History }>('/api/prod')
    if (!history.some((h) => h.event === 'promoted' && !h.reverted && h.title === BUG1_TITLE)) return
    await api('/api/prod/rollback', { method: 'POST', body: JSON.stringify({ by: 'e2e setup' }) })
  }
  throw new Error('could not remove the bug1 fix from production')
}

async function devBoard(page: Page) {
  await openBoard(page)
  await expect(page.locator('.brand')).toContainText('CONTROL ROOM')
  await setMode(page, 'Dev')
}

test.beforeAll(async () => {
  try {
    await api('/api/meta')
  } catch {
    throw new Error(`factory serve is not reachable at ${FACTORY_URL}. Start it with .venv/bin/factory serve (or set FACTORY_URL).`)
  }
})

// never leave the shared line stopped, whatever a test did
test.afterEach(async () => {
  await api('/api/line/resume', { method: 'POST', body: JSON.stringify({ by: 'e2e', reason: 'cleanup' }) })
})

test('meta lists the eight stations the board draws', async ({ page }) => {
  const meta = await api<{ stations: string[] }>('/api/meta')
  expect(meta.stations).toEqual(['scope', 'baseline', 'reproduce', 'fix', 'oracle', 'diff_inspection', 'review', 'deploy'])
  await devBoard(page)
  await expect(page.locator('.colh')).toHaveCount(meta.stations.length + 2)
})

test('Run all in Dev: bugs 1 to 5 ship, 6 and 7 stop at scope', async ({ page }) => {
  await devBoard(page)
  await runAll(page)
  for (const bug of ['bug1', 'bug2', 'bug3', 'bug4', 'bug5']) {
    await finished(lane(page, bug))
    await expect(lane(page, bug)).toHaveAttribute('data-outcome', 'shipped')
    await expect(cell(lane(page, bug), 'review')).toHaveAttribute('data-status', 'off')
  }
  for (const [bug, area] of [['bug6', 'non-deterministic'], ['bug7', 'authentication']]) {
    await finished(lane(page, bug))
    await expect(cell(lane(page, bug), 'scope')).toHaveAttribute('data-status', 'escalate')
    await inspect(lane(page, bug), 'scope')
    await expect(inspector(page)).toContainText(area)
  }
})

test('rogue:delete_test: oracle passes, diff inspection rejects', async ({ page }) => {
  await devBoard(page)
  await runOne(page, { bug: 'bug1', fixer: 'rogue:delete_test' })
  const l = lane(page, 'bug1', 'rogue:delete_test')
  await finished(l)
  await expect(cell(l, 'oracle')).toHaveAttribute('data-status', 'pass')
  await expect(cell(l, 'diff_inspection')).toHaveAttribute('data-status', 'escalate')
  await inspect(l, 'diff_inspection')
  await expect(inspector(page)).toContainText('The tests alone would have shipped this')
  await expect(inspector(page)).toContainText('test_deletions')
})

test('andon: a run started while the line is stopped lands in the queue as stopped', async ({ page }) => {
  await devBoard(page)
  await holdAndon(page)
  await expect(page.getByText('LINE STOPPED', { exact: true })).toBeVisible()
  await page.fill('#andon-reason', 'e2e contract test')
  await page.getByRole('button', { name: 'Save reason' }).click()
  await runOne(page, { bug: 'bug2' })
  const l = lane(page, 'bug2')
  await expect(l).toHaveAttribute('data-outcome', 'stopped')
  await inspect(l, 'scope')
  await expect(inspector(page)).toContainText('e2e contract test')
  await page.getByRole('button', { name: 'Resume line' }).click()
  await expect(page.getByText('LINE RUNNING', { exact: true })).toBeVisible()
})

test('replay of a shipped run matches the record', async ({ page }) => {
  await devBoard(page)
  await runOne(page, { bug: 'bug4' })
  const l = lane(page, 'bug4')
  await finished(l)
  await expect(l).toHaveAttribute('data-outcome', 'shipped')
  await l.locator('.outcome').click()
  await page.getByRole('button', { name: 'Replay this run' }).click()
  await expect(page.locator('.drawer')).toContainText('Replay matches the record', { timeout: 60_000 })
})

test('audit pill turns red at the edited line and green when restored', async ({ page }) => {
  const log = path.join(RUNS_DIR, 'events.jsonl')
  test.skip(!fs.existsSync(log), `no event log at ${log} (set E2E_RUNS_DIR)`)
  await devBoard(page)
  await expect(auditPill(page)).toContainText('chain intact')
  const original = fs.readFileSync(log)
  try {
    const lines = original.toString('utf8').split('\n')
    const i = lines.findIndex((l) => l.includes('"reason": "'))
    lines[i] = lines[i].replace('"reason": "', '"reason": "edited: ')
    fs.writeFileSync(log, lines.join('\n'))
    await expect(auditPill(page)).toContainText(`line ${i + 1}: content was modified`, { timeout: 15_000 })
  } finally {
    fs.writeFileSync(log, original)
  }
  await expect(auditPill(page)).toContainText('chain intact', { timeout: 15_000 })
})

test('canary: slow_fix rolls back in Dev, the honest fix is promoted, the kill switch reverts it', async ({ page }) => {
  test.setTimeout(240_000)
  await productionWithoutBug1Fix()
  await devBoard(page)

  const sent: string[] = []
  page.on('request', (r) => { if (r.method() === 'POST' && r.url().endsWith('/api/runs')) sent.push(r.postData() ?? '') })
  await runOne(page, { bug: 'bug1', fixer: 'rogue:slow_fix' })
  const slow = lane(page, 'bug1', 'rogue:slow_fix')
  await finished(slow, 120_000)
  expect(JSON.parse(sent[0])).toMatchObject({ fixer: 'rogue:slow_fix', reproducer: 'dev', deploy: 'canary' })
  await expect(cell(slow, 'deploy')).toHaveAttribute('data-status', 'escalate')
  await inspect(slow, 'deploy')
  await expect(inspector(page).locator('.canary-headline')).toHaveText('Rolled back automatically. Stable was never touched.')
  await expect(inspector(page).locator('.cstep.breach')).toContainText('10%')

  const before = await page.locator('.prod .pill').innerText()
  await runOne(page, { bug: 'bug1', deploy: 'canary' })
  const honest = lane(page, 'bug1', 'reference')
  await finished(honest, 120_000)
  await expect(honest).toHaveAttribute('data-outcome', 'shipped')
  await inspect(honest, 'deploy')
  await expect(inspector(page).locator('.canary-headline')).toContainText('Promoted to production')
  await expect(page.locator('.prod .pill')).not.toHaveText(before, { timeout: 10_000 })

  await page.getByRole('button', { name: 'Roll back last fix' }).click()
  await expect(page.locator('.popover')).toContainText(BUG1_TITLE)
  await page.getByRole('button', { name: 'Roll back now' }).click()
  await expect(page.locator('.popover')).toContainText('Done: reverted', { timeout: 60_000 })
})
