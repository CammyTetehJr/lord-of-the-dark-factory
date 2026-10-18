import { expect, test } from '@playwright/test'
import { cell, finished, hold, lane, openBoard, resetButton, rollbackButton, runOne, setMode } from '../helpers.ts'

type MockWindow = typeof globalThis & {
  __factoryMock: { prodReset: (by: string) => Promise<{ ok: boolean; message: string }> }
  resetCalls: number
  releaseReset: () => void
}

test.beforeEach(async ({ page }) => { await openBoard(page, '?source=mock&speed=30') })

test('reset requires a full hold, announces progress, excludes other changes, and restores the bugs', async ({ page }) => {
  await setMode(page, 'Dev')
  await runOne(page, { bug: 'bug1', deploy: 'canary' })
  await finished(lane(page, 'bug1'))
  const before = await page.locator('.prod .pill').innerText()
  await page.evaluate(() => {
    const w = globalThis as MockWindow
    const reset = w.__factoryMock.prodReset
    w.resetCalls = 0
    w.__factoryMock.prodReset = async (by) => {
      w.resetCalls++
      await new Promise<void>((resolve) => { w.releaseReset = resolve })
      return reset(by)
    }
  })
  await resetButton(page).click()
  await page.waitForTimeout(1100)
  expect(await page.evaluate(() => (globalThis as MockWindow).resetCalls)).toBe(0)
  await resetButton(page).focus()
  await page.keyboard.down('Space')
  await page.waitForTimeout(200)
  await page.keyboard.up('Space')
  await page.waitForTimeout(1100)
  expect(await page.evaluate(() => (globalThis as MockWindow).resetCalls)).toBe(0)
  // Losing focus cancels a keyboard hold, even if keyup goes to a different control.
  await page.keyboard.down('Enter')
  await page.keyboard.press('Tab')
  await page.waitForTimeout(1100)
  await page.keyboard.up('Enter')
  expect(await page.evaluate(() => (globalThis as MockWindow).resetCalls)).toBe(0)
  await resetButton(page).focus()
  await page.keyboard.down('Space')
  await expect(page.locator('.prod [role="status"]')).toContainText('Resetting production')
  await page.keyboard.up('Space')
  await expect(resetButton(page)).toBeDisabled()
  await expect(rollbackButton(page)).toBeDisabled()
  await expect(rollbackButton(page)).not.toContainText('Rolling back…')
  await expect(page.locator('[data-scenario="nasty"]').getByRole('button', { name: 'Run', exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: /Run all/ })).toBeDisabled()
  await page.evaluate(() => (globalThis as MockWindow).releaseReset())
  await expect(page.locator('.prod [role="status"]')).toContainText('All seeded bugs are back')
  await expect(page.locator('.prod .pill')).not.toHaveText(before)
  await expect(rollbackButton(page)).toBeDisabled()
  expect(await page.evaluate(() => (globalThis as MockWindow).resetCalls)).toBe(1)
  await runOne(page, { bug: 'bug1', deploy: 'canary' })
  await expect(page.locator('.lane[data-bug="bug1"]')).toHaveCount(2)
  await finished(lane(page, 'bug1'))
  await expect(lane(page, 'bug1')).toHaveAttribute('data-outcome', 'shipped')
})

test('reset failures are errors, controls recover, and a retry can succeed', async ({ page }) => {
  await page.evaluate(() => {
    const w = globalThis as MockWindow
    const reset = w.__factoryMock.prodReset
    w.__factoryMock.prodReset = async () => {
      w.__factoryMock.prodReset = reset
      throw new Error('Production is unavailable')
    }
  })
  await hold(page, resetButton(page))
  await expect(page.locator('.prod [role="alert"]')).toContainText('Not reset: Production is unavailable')
  await expect(resetButton(page)).toBeEnabled()
  await hold(page, resetButton(page))
  await expect(page.locator('.prod [role="status"]')).toContainText('All seeded bugs are back')
})

test('the guide runs its prescribed scenarios without changing the launcher mode', async ({ page }) => {
  const guide = page.getByRole('region', { name: 'Judge guide' })
  await expect(guide.locator('.scenario')).toHaveCount(5)
  const easy = guide.locator('[data-scenario="easy"]')
  await expect(page.getByRole('button', { name: 'Dev', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await easy.getByRole('button', { name: 'Run', exact: true }).click()
  await finished(lane(page, 'bug3'))
  await expect(lane(page, 'bug3')).toHaveAttribute('data-outcome', 'shipped')
  await expect(cell(lane(page, 'bug3'), 'review')).toHaveAttribute('data-status', 'pass')
  await expect(lane(page, 'bug3').locator('.chip.you')).toHaveText('you')
  await expect(easy.locator('.scenario-results')).toContainText('Shipped')
  await expect(page.getByRole('button', { name: 'Dev', exact: true })).toHaveAttribute('aria-pressed', 'true')

  // The second run resets only because production now contains fix(bug3).
  await easy.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(easy.locator('.scenario-note')).toContainText('fix(bug3)')
  await expect(page.locator('.lane[data-bug="bug3"]')).toHaveCount(2)
  await finished(lane(page, 'bug3'))

  await easy.getByRole('button', { name: 'or all five' }).click()
  for (const id of ['bug1', 'bug2', 'bug3', 'bug4', 'bug5']) await finished(lane(page, id))

  await guide.locator('[data-scenario="nasty"]').getByRole('button', { name: 'Run', exact: true }).click()
  for (const id of ['bug6', 'bug7']) {
    await finished(lane(page, id))
    await expect(cell(lane(page, id), 'scope')).toHaveAttribute('data-status', 'escalate')
  }

  // Scenario 3 has no automatic reset by design; isolate it from the earlier shipping demo.
  await hold(page, resetButton(page))
  await guide.locator('[data-scenario="rogue"]').getByRole('button', { name: 'Run', exact: true }).click()
  await finished(lane(page, 'bug1', 'rogue:delete_test'))
  await expect(cell(lane(page, 'bug1', 'rogue:delete_test'), 'oracle')).toHaveAttribute('data-status', 'pass')
  await expect(cell(lane(page, 'bug1', 'rogue:delete_test'), 'diff_inspection')).toHaveAttribute('data-status', 'escalate')
  await finished(lane(page, 'bug3', 'rogue:game_test'))
  await expect(cell(lane(page, 'bug3', 'rogue:game_test'), 'review')).toHaveAttribute('data-status', 'escalate')

  await guide.locator('[data-scenario="slow"]').getByRole('button', { name: 'Run', exact: true }).click()
  const prodBefore = await page.locator('.prod .pill').innerText()
  await finished(lane(page, 'bug1', 'rogue:slow_fix'))
  await expect(cell(lane(page, 'bug1', 'rogue:slow_fix'), 'deploy')).toHaveAttribute('data-status', 'escalate')
  await expect(page.locator('.prod .pill')).toHaveText(prodBefore)

  await guide.getByRole('button', { name: 'Audit pill' }).click()
  await expect(page.locator('.audit-pill')).toHaveClass(/guide-pulse/)
  await guide.getByRole('button', { name: 'Replay' }).click()
  await expect(page.locator('.drawer .replay-control')).toHaveClass(/guide-pulse/)
  await page.getByRole('button', { name: 'Close · Esc' }).click()
  await guide.getByRole('button', { name: 'Hide' }).click()
  await expect(page.getByRole('button', { name: 'Try it' })).toBeVisible()
  await page.reload()
  await expect(guide).toHaveCount(0)
  await page.getByRole('button', { name: 'Try it' }).click()
  await expect(page.getByRole('region', { name: 'Judge guide' })).toBeVisible()
})

test('a refused reset never launches the slow scenario', async ({ page }) => {
  await setMode(page, 'Dev')
  await runOne(page, { bug: 'bug1', deploy: 'canary' })
  await finished(lane(page, 'bug1'))
  await page.getByRole('button', { name: 'Clear board' }).click()
  await page.evaluate(() => {
    const w = globalThis as MockWindow
    w.__factoryMock.prodReset = async () => ({ ok: false, message: 'Reset refused' })
  })
  await page.locator('[data-scenario="slow"]').getByRole('button', { name: 'Run', exact: true }).click()
  await expect(page.locator('[data-scenario="slow"] .scenario-error')).toContainText('No scenario runs were started')
  await expect(page.locator('.lane')).toHaveCount(0)
  await expect(resetButton(page)).toBeEnabled()
})

test('header controls and guide fit laptop and desktop widths with a populated audit pill', async ({ page }) => {
  await setMode(page, 'Dev')
  await runOne(page, { bug: 'bug1', deploy: 'canary' })
  await finished(lane(page, 'bug1'))
  await expect(page.locator('.audit-pill')).toContainText('Chain intact')
  await expect(page.locator('.mobile-run-status')).toBeHidden()
  for (const width of [1280, 1440, 1920]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const selector of ['.audit-pill', '.prod', '.prod .kill', '.prod .reset', '.andon', '.judge-guide']) {
      const el = page.locator(selector)
      await expect(el).toBeVisible()
      const box = await el.boundingBox()
      expect(box!.x).toBeGreaterThanOrEqual(0)
      expect(box!.x + box!.width).toBeLessThanOrEqual(width)
      expect(await el.evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true)
    }
    const rollback = await rollbackButton(page).boundingBox()
    const reset = await resetButton(page).boundingBox()
    expect(reset!.y).toBe(rollback!.y)
    expect(reset!.x).toBeGreaterThanOrEqual(rollback!.x + rollback!.width)
    await page.screenshot({ path: `test-results/judge-${width}.png`, fullPage: true })
  }
})

test('phone layout contains overlays and keeps wide content in its own scroller', async ({ page }) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 })
    await expect(page.locator('.gbar')).toBeVisible()
    expect(await page.locator('html').evaluate((element) => element.scrollWidth)).toBe(width)
  }

  const scenarios = page.locator('.scenario-list')
  expect(await scenarios.evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/mobile-390-home.png', fullPage: true })

  await page.getByRole('button', { name: 'Run one…' }).click()
  const launcher = page.locator('.popover').filter({ hasText: 'Run one bug' })
  const popover = await launcher.boundingBox()
  expect(popover!.x).toBeGreaterThanOrEqual(0)
  expect(popover!.x + popover!.width).toBeLessThanOrEqual(390)
  expect(popover!.y + popover!.height).toBeLessThanOrEqual(844)
  await launcher.getByRole('button', { name: 'Cancel' }).click()

  await setMode(page, 'Dev')
  await runOne(page, { bug: 'bug1' })
  await expect(page.locator('.mobile-run-status')).toBeVisible()
  await finished(lane(page, 'bug1'))
  await expect(page.locator('.mobile-run-status')).toHaveText('Shipped')
  await expect(page.locator('.board-swipe')).toBeVisible()
  expect(await page.locator('html').evaluate((element) => element.scrollWidth)).toBe(390)
  await page.locator('.boardwrap').evaluate((element) => { element.scrollLeft = element.scrollWidth })
  await expect(page.locator('.mobile-run-status')).toBeVisible()
  await lane(page, 'bug1').locator('.outcome').click()
  const drawer = page.locator('.drawer')
  await expect(drawer).toBeVisible()
  await page.waitForTimeout(400)
  const box = await drawer.boundingBox()
  expect(box!.x).toBe(0)
  expect(box!.width).toBe(390)
  expect(box!.height).toBe(844)
  await page.screenshot({ path: 'test-results/mobile-390-drawer.png' })
})
