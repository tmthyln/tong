import { test, expect, type Page } from '@playwright/test'

/**
 * Opens the account menu in the nav drawer. The drawer is rail-collapsed and
 * expands on hover, so hover first to make the overflow "⋮" button clickable.
 * The icon button has no text label, so target it by its mdi icon class.
 */
async function openAccountMenu(page: Page) {
  // The left drawer holds the account menu; the right drawer is the AgentPanel.
  const nav = page.locator('nav.v-navigation-drawer--left')
  await nav.hover()
  await nav.locator('button:has(i.mdi-dots-vertical)').click()
}

test.describe('authentication', () => {
  test('starts as a read-only public user', async ({ page }) => {
    await page.goto('/')
    await openAccountMenu(page)

    // The public menu offers a way in; an authenticated menu would show "Sign out".
    await expect(page.getByText('Test account', { exact: true })).toBeVisible()
    await expect(page.getByText('Sign out')).toHaveCount(0)
  })

  test('creating a test account signs the user in', async ({ page }) => {
    await page.goto('/')

    await openAccountMenu(page)
    await page.getByText('Test account', { exact: true }).click()

    // Reopen the menu; once the session cookie is set the reactive menu swaps to
    // the authenticated view whose only action is "Sign out".
    await openAccountMenu(page)
    await expect(page.getByText('Sign out')).toBeVisible()

    // The session survives a reload (httpOnly cookie), so no re-login prompt.
    await page.reload()
    await openAccountMenu(page)
    await expect(page.getByText('Sign out')).toBeVisible()
  })
})
