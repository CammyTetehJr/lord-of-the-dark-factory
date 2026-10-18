// Every demo beat from docs/ui-handoff.md against the in-browser mock. No backend needed.
import { expect, test } from '@playwright/test'
import { auditPill, cell, finished, hold, holdAndon, inspect, inspector, lane, openBoard, rollbackButton, runAll, runOne, setMode } from '../helpers.ts'

const MOCK = '?source=mock&speed=5'

test.beforeEach(async ({ page }) => {
  await openBoard(page, MOCK)
  await expect(page.locator('.brand')).toContainText('MOCK DATA')
})

test('Run all in Dev: bugs 1 to 5 ship, 6 and 7 stop at scope', async ({ page }) => {
  await setMode(page, 'Dev')
  await runAll(page)
  for (const bug of ['bug1', 'bug2', 'bug3', 'bug4', 'bug5']) {
    await finished(lane(page, bug))
    await expect(lane(page, bug)).toHaveAttribute('data-outcome', 'shipped')
    await expect(cell(lane(page, bug), 'review')).toHaveAttribute('data-status', 'off')
  }
  for (const [bug, area] of [['bug6', 'non-deterministic'], ['bug7', 'authentication']]) {
    await finished(lane(page, bug))
    await expect(lane(page, bug)).toHaveAttribute('data-outcome', 'escalated')
    await expect(cell(lane(page, bug), 'scope')).toHaveAttribute('data-status', 'escalate')
    await expect(page.locator('.qi').filter({ hasText: bug })).toContainText(area)
  }
  // lanes in a batch read in bug order
  await expect(page.locator('.lane')).toHaveCount(7)
  expect(await page.locator('.lane').evaluateAll((ls) => ls.map((l) => l.getAttribute('data-bug')))).toEqual(
    ['bug1', 'bug2', 'bug3', 'bug4', 'bug5', 'bug6', 'bug7'])
})

test('rogue:delete_test: oracle passes, diff inspection rejects, side by side', async ({ page }) => {
  await setMode(page, 'Dev')
  await runOne(page, { bug: 'bug1', fixer: 'rogue:delete_test' })
  const l = lane(page, 'bug1', 'rogue:delete_test')
  await finished(l)
  await expect(cell(l, 'oracle')).toHaveAttribute('data-status', 'pass')
  await expect(cell(l, 'diff_inspection')).toHaveAttribute('data-status', 'escalate')
  await inspect(l, 'diff_inspection')
  await expect(inspector(page)).toContainText('The tests alone would have shipped this')
  await expect(inspector(page)).toContainText('test_deletions')
})

test('rogue:game_test in Live: everything passes until the reviewer vetoes', async ({ page }) => {
  await page.goto('/?source=mock&speed=20')
  await setMode(page, 'Live')
  await runOne(page, { bug: 'bug3', fixer: 'rogue:game_test', deploy: 'branch' })
  const l = lane(page, 'bug3', 'rogue:game_test')
  await finished(l)
  for (const s of ['scope', 'baseline', 'reproduce', 'fix', 'oracle', 'diff_inspection']) await expect(cell(l, s)).toHaveAttribute('data-status', 'pass')
  await expect(cell(l, 'review')).toHaveAttribute('data-status', 'escalate')
  await inspect(l, 'review')
  await expect(inspector(page)).toContainText('vetoed')
  await expect(inspector(page)).toContainText('hardcodes the exact test input')
})

test('Live scope shows the three classifier votes', async ({ page }) => {
  await page.goto('/?source=mock&speed=20')
  await setMode(page, 'Live')
  await runOne(page, { bug: 'bug2', deploy: 'branch' })
  const l = lane(page, 'bug2')
  await expect(cell(l, 'scope')).toHaveAttribute('data-status', 'pass')
  await inspect(l, 'scope')
  await expect(inspector(page)).toContainText('3/3 votes say trivial')
  await expect(inspector(page).locator('.call')).toHaveCount(3)
})

test('andon: stop the line, a new run lands in the queue as stopped, resume', async ({ page }) => {
  await holdAndon(page)
  await expect(page.getByText('LINE STOPPED', { exact: true })).toBeVisible()
  await page.fill('#andon-reason', 'e2e: checking a diff')
  await page.getByRole('button', { name: 'Save reason' }).click()
  await setMode(page, 'Dev')
  await runOne(page, { bug: 'bug2' })
  const l = lane(page, 'bug2')
  await expect(l).toHaveAttribute('data-outcome', 'stopped')
  await expect(cell(l, 'scope')).toHaveAttribute('data-status', 'held')
  await expect(page.locator('.qi.held')).toContainText('Line paused by a human operator')
  await page.getByRole('button', { name: 'Resume line' }).click()
  await expect(page.getByText('LINE RUNNING', { exact: true })).toBeVisible()
})

test('canary: slow_fix rolls back, the honest fix is promoted, the kill switch reverts it', async ({ page }) => {
  await setMode(page, 'Dev')
  // default deploy for slow_fix is the canary, even in Dev
  await runOne(page, { bug: 'bug1', fixer: 'rogue:slow_fix' })
  const slow = lane(page, 'bug1', 'rogue:slow_fix')
  await finished(slow)
  await expect(cell(slow, 'deploy')).toHaveAttribute('data-status', 'escalate')
  await inspect(slow, 'deploy')
  await expect(inspector(page).locator('.canary-headline')).toHaveText('Rolled back automatically. Stable was never touched.')
  await expect(inspector(page).locator('.cstep.breach')).toContainText('10%')

  await runOne(page, { bug: 'bug1', deploy: 'canary' })
  const honest = lane(page, 'bug1', 'reference')
  await finished(honest)
  await expect(honest).toHaveAttribute('data-outcome', 'shipped')
  await inspect(honest, 'deploy')
  await expect(inspector(page).locator('.canary-headline')).toContainText('Promoted to production')
  await expect(inspector(page).locator('.cstep.ok')).toHaveCount(3)

  // the kill switch names what it will revert, a click alone does nothing, a one-second hold reverts it
  await expect(rollbackButton(page)).toContainText('Invoice list shows the same invoice on two pages')
  const prodBefore = await page.locator('.prod .pill').innerText()
  await rollbackButton(page).click()
  await page.waitForTimeout(1500)
  await expect(page.locator('.popover.toast')).toHaveCount(0)
  await expect(page.locator('.prod .pill')).toHaveText(prodBefore)
  await hold(page, rollbackButton(page))
  await expect(page.locator('.popover.toast')).toContainText('Rolled back')
  await expect(page.locator('.prod .pill')).not.toHaveText(prodBefore)
  await expect(rollbackButton(page)).toBeDisabled()
  await expect(rollbackButton(page)).toContainText('nothing promoted')
})

test('replay of a shipped run matches the record', async ({ page }) => {
  await setMode(page, 'Dev')
  await runOne(page, { bug: 'bug4' })
  const l = lane(page, 'bug4')
  await finished(l)
  await l.locator('.outcome').click()
  await page.getByRole('button', { name: 'Replay this run' }).click()
  await expect(page.locator('.drawer')).toContainText('Replay matches the record')
  await page.keyboard.press('Escape')
  await expect(page.locator('.drawer')).toHaveCount(0)
})

test('audit pill turns red when the chain breaks and green when restored', async ({ page }) => {
  await setMode(page, 'Dev')
  await runOne(page, { bug: 'bug3' })
  await finished(lane(page, 'bug3'))
  await expect(auditPill(page)).toContainText('chain intact')
  await page.evaluate(() => (globalThis as unknown as { __factoryMock: { tamper(): void } }).__factoryMock.tamper())
  await expect(auditPill(page)).toContainText(/line \d+: content was modified/, { timeout: 10_000 })
  await expect(page.locator('.ticker li.broken')).toHaveCount(1)
  await page.evaluate(() => (globalThis as unknown as { __factoryMock: { restore(): void } }).__factoryMock.restore())
  await expect(auditPill(page)).toContainText('chain intact', { timeout: 10_000 })
})

test('run drawer names the agent, model and power at every step', async ({ page }) => {
  await page.goto('/?source=mock&speed=20')
  await setMode(page, 'Live')
  await runOne(page, { bug: 'bug3', fixer: 'rogue:game_test', deploy: 'branch' })
  const l = lane(page, 'bug3', 'rogue:game_test')
  await finished(l)
  await l.locator('.outcome').click()
  const drawer = page.locator('.drawer')
  // crew: every model agent with its model
  await expect(drawer.locator('.crew-card', { hasText: 'Scope classifier' })).toContainText('Nemotron-3_5-Lightning')
  await expect(drawer.locator('.crew-card', { hasText: 'Test writer' })).toContainText('nemotron-3-super-120b-a12b')
  await expect(drawer.locator('.crew-card', { hasText: 'Fixer' })).toContainText('adversarial')
  await expect(drawer.locator('.crew-card', { hasText: 'Reviewer' })).toContainText('Nemotron-3-Ultra-550b-a55b')
  // steps: numbered, one per station, each header naming who works there
  await expect(drawer.locator('.step')).toHaveCount(8)
  await expect(drawer.locator('.step[data-station="scope"] .step-h')).toContainText('Scope classifier')
  await expect(drawer.locator('.step[data-station="diff_inspection"] .step-h')).toContainText('Diff inspector')
  // the escalated step opens by default and shows the reviewer's card and its call, once
  const review = drawer.locator('.step[data-station="review"]')
  await expect(review.locator('.step-h')).toHaveAttribute('aria-expanded', 'true')
  await expect(review.locator('.agent-card')).toContainText('can only veto')
  await expect(review.locator('.agent-card')).toContainText('veto')
  await expect(review.locator('.call')).toHaveCount(1)
  // expanding a passed step shows its agents
  await drawer.locator('.step[data-station="oracle"] .step-h').click()
  await expect(drawer.locator('.step[data-station="oracle"] .agent-card')).toContainText('decides')
})

test('a bug already fixed in production closes without a human', async ({ page }) => {
  await setMode(page, 'Dev')
  await runOne(page, { bug: 'bug1', deploy: 'canary' })
  await finished(lane(page, 'bug1'))
  await expect(lane(page, 'bug1')).toHaveAttribute('data-outcome', 'shipped')
  await runOne(page, { bug: 'bug1', deploy: 'canary' })
  await expect(page.locator('.lane[data-bug="bug1"]')).toHaveCount(2)
  const again = lane(page, 'bug1')
  await finished(again)
  await expect(again).toHaveAttribute('data-outcome', 'closed')
  await expect(cell(again, 'reproduce')).toHaveAttribute('data-status', 'closed')
  await expect(cell(again, 'fix')).toHaveAttribute('data-status', 'skipped')
  await expect(page.locator('.qi')).toHaveCount(0)
  await again.locator('.outcome').click()
  await expect(page.locator('.drawer .step[data-station="reproduce"] .agent-card', { hasText: 'Production check' })).toContainText('already fixed by')
})
