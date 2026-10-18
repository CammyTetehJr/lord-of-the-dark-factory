// The DARK FACTORY title leads back home: a full reload that closes whatever was open.
import { expect, test } from '@playwright/test'
import { openBoard } from '../helpers.ts'

test('the DARK FACTORY title reloads the page and closes what was open', async ({ page }) => {
  await openBoard(page, '?source=mock&speed=5')
  await page.getByRole('button', { name: 'Run one…' }).click()
  await expect(page.locator('.popover')).toBeVisible()
  await Promise.all([page.waitForNavigation(), page.getByRole('link', { name: /Dark Factory/ }).click()])
  await expect(page).toHaveURL(/\?source=mock$/)
  await expect(page.locator('.popover')).toHaveCount(0)
})
