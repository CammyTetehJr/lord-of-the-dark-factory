// Layout on common laptop widths (issue #8): the board must never slide under the rail, the
// Run one popover must stay inside the board's pane, and the title must lead back home.
import { expect, test, type Page } from '@playwright/test'
import { finished, lane, openBoard, runAll, setMode } from '../helpers.ts'

const MOCK = '?source=mock&speed=5'

async function rightOf(page: Page, selector: string): Promise<number> {
  return page.locator(selector).evaluateAll((els) => Math.max(...els.map((e) => e.getBoundingClientRect().right)))
}

for (const width of [1280, 1440]) {
  test(`at ${width}px every outcome is visible and nothing reaches under the rail`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 })
    await openBoard(page, MOCK)
    await setMode(page, 'Dev')
    await runAll(page)
    for (const bug of ['bug1', 'bug7']) await finished(lane(page, bug))

    const railLeft = await page.locator('.rail').evaluate((e) => e.getBoundingClientRect().left)
    expect(await rightOf(page, '.outcome')).toBeLessThanOrEqual(railLeft)
    for (const o of await page.locator('.outcome').all()) await expect(o).toBeInViewport({ ratio: 1 })

    // Run one is clickable (it used to sit under the rail) and opens as the active button
    const runOne = page.getByRole('button', { name: 'Run one…' })
    await runOne.click()
    await expect(runOne).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByRole('button', { name: /Run all/ })).not.toHaveClass(/primary/)
    // the popover and everything inside it stay left of the rail
    expect(await rightOf(page, '.popover, .popover *')).toBeLessThanOrEqual(railLeft)
  })
}

test('the DARK FACTORY title reloads the page and closes what was open', async ({ page }) => {
  await openBoard(page, MOCK)
  await page.getByRole('button', { name: 'Run one…' }).click()
  await expect(page.locator('.popover')).toBeVisible()
  await Promise.all([page.waitForNavigation(), page.getByRole('link', { name: /Dark Factory/ }).click()])
  await expect(page).toHaveURL(/\?source=mock$/)
  await expect(page.locator('.popover')).toHaveCount(0)
})
