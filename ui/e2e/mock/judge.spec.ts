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
  await expect(page.getByRole('button', { name: 'Try nasty bugs' })).toBeDisabled()
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

test('the guide runs all five scenarios with Live roles and resets already-fixed bugs', async ({ page }) => {
  const guide = page.getByRole('region', { name: 'Judge guide' })
  await expect(guide.locator('.scenario')).toHaveCount(5)
  const easy = page.getByRole('button', { name: 'Hold to try: Fix the easy bugs', exact: true })
  await easy.click()
  await page.waitForTimeout(1100)
  await expect(page.locator('.lane')).toHaveCount(0)
  await hold(page, easy)
  await expect(page.getByRole('button', { name: 'Live · Nemotron', exact: true })).toHaveAttribute('aria-pressed', 'true')
  for (const id of ['bug1', 'bug2', 'bug3', 'bug4', 'bug5']) {
    await finished(lane(page, id))
    await expect(lane(page, id)).toHaveAttribute('data-outcome', 'shipped')
    await expect(cell(lane(page, id), 'review')).toHaveAttribute('data-status', 'pass')
  }
  // A later judge must see fixes ship too, rather than five "already fixed" outcomes.
  await hold(page, easy)
  await expect(page.locator('.lane')).toHaveCount(10)
  for (const id of ['bug1', 'bug2', 'bug3', 'bug4', 'bug5']) {
    await finished(lane(page, id))
    await expect(lane(page, id)).toHaveAttribute('data-outcome', 'shipped')
  }
  await page.getByRole('button', { name: 'Try nasty bugs' }).click()
  for (const id of ['bug6', 'bug7']) {
    await finished(lane(page, id))
    await expect(cell(lane(page, id), 'scope')).toHaveAttribute('data-status', 'escalate')
  }
  await hold(page, page.getByRole('button', { name: 'Hold to try: Plug in a bad robot arm', exact: true }))
  await finished(lane(page, 'bug1', 'rogue:delete_test'))
  await expect(cell(lane(page, 'bug1', 'rogue:delete_test'), 'oracle')).toHaveAttribute('data-status', 'pass')
  await expect(cell(lane(page, 'bug1', 'rogue:delete_test'), 'diff_inspection')).toHaveAttribute('data-status', 'escalate')
  await finished(lane(page, 'bug3', 'rogue:game_test'))
  await expect(cell(lane(page, 'bug3', 'rogue:game_test'), 'review')).toHaveAttribute('data-status', 'escalate')
  await hold(page, page.getByRole('button', { name: 'Hold to try: Ship something slow', exact: true }))
  const prodBefore = await page.locator('.prod .pill').innerText()
  await finished(lane(page, 'bug1', 'rogue:slow_fix'))
  await expect(cell(lane(page, 'bug1', 'rogue:slow_fix'), 'deploy')).toHaveAttribute('data-status', 'escalate')
  await expect(page.locator('.prod .pill')).toHaveText(prodBefore)
  await page.getByRole('button', { name: 'Show me how' }).click()
  await expect(guide.locator('.human-guide')).toContainText('Replay this run')
  await expect(guide.locator('.human-guide')).toContainText('Resume line')
  await page.getByRole('button', { name: /Hide guide/ }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: /Show guide/ })).toHaveAttribute('aria-expanded', 'false')
})

test('a refused reset never launches the slow scenario', async ({ page }) => {
  await page.evaluate(() => {
    const w = globalThis as MockWindow
    w.__factoryMock.prodReset = async () => ({ ok: false, message: 'Reset refused' })
  })
  await hold(page, page.getByRole('button', { name: 'Hold to try: Ship something slow', exact: true }))
  await expect(page.locator('.guide-status[role="alert"]')).toContainText('No scenario runs were started')
  await expect(page.locator('.lane')).toHaveCount(0)
  await expect(resetButton(page)).toBeEnabled()
})

test('header controls and guide fit laptop and desktop widths with a populated audit pill', async ({ page }) => {
  await setMode(page, 'Dev')
  await runOne(page, { bug: 'bug1', deploy: 'canary' })
  await finished(lane(page, 'bug1'))
  await expect(page.locator('.audit-pill')).toContainText('Chain intact')
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
