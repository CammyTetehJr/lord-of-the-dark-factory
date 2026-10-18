import { expect, type Locator, type Page } from '@playwright/test'

export const FACTORY_URL = process.env.FACTORY_URL ?? 'http://127.0.0.1:8100'

/** Open the board. `query` selects the source, e.g. '?source=mock&speed=5'. */
export async function openBoard(page: Page, query = '') {
  await page.goto('/' + query)
  await expect(page.getByRole('heading', { name: 'The line' })).toBeVisible()
  // the real server keeps earlier runs; start each test from an empty board
  const clear = page.getByRole('button', { name: 'Clear board' })
  if (await clear.isVisible()) await clear.click()
}

export async function setMode(page: Page, mode: 'Dev' | 'Live') {
  await page.getByRole('button', { name: mode === 'Dev' ? 'Dev' : /Live/, exact: mode === 'Dev' }).click()
}

export async function runAll(page: Page) {
  await page.getByRole('button', { name: /Run all/ }).click()
}

export async function runOne(page: Page, { bug, fixer = 'default', deploy = 'default' }: { bug: string; fixer?: string; deploy?: string }) {
  await page.getByRole('button', { name: 'Run one…' }).click()
  await page.selectOption('#run-bug', bug)
  await page.selectOption('#run-fixer', fixer)
  await page.selectOption('#run-deploy', deploy)
  await page.getByRole('button', { name: 'Start run' }).click()
}

/** The newest lane for this bug (and fixer, when two lanes share a bug). */
export function lane(page: Page, bug: string, fixer?: string): Locator {
  return page.locator(`.lane[data-bug="${bug}"]${fixer ? `[data-fixer="${fixer}"]` : ''}`).last()
}

export function cell(l: Locator, station: string): Locator {
  return l.locator(`[data-station="${station}"]`)
}

export async function finished(l: Locator, timeout = 90_000) {
  await expect(l).toHaveAttribute('data-outcome', /^(shipped|escalated|closed|stopped|crashed)$/, { timeout })
}

export async function inspect(l: Locator, station: string) {
  await cell(l, station).click()
}

export const inspector = (page: Page) => page.locator('.inspector')

/** Press and hold a hold-to-confirm control past its one-second threshold. */
export async function hold(page: Page, l: Locator) {
  await expect(l).toBeEnabled()
  const box = await l.boundingBox()
  if (!box) throw new Error('control not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1300)
  await page.mouse.up()
}

export const rollbackButton = (page: Page) => page.getByRole('button', { name: /^Hold to roll back/ })
export const resetButton = (page: Page) => page.getByRole('button', { name: /^Hold to reset production/ })

/** The andon cord needs a one-second hold. */
export async function holdAndon(page: Page) {
  const box = await page.getByRole('button', { name: /Stop the line/ }).boundingBox()
  if (!box) throw new Error('andon cord not visible')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1300)
  await page.mouse.up()
}

export const auditPill = (page: Page) => page.locator('.audit-pill')
