import { test, expect } from '@playwright/test'

test.describe('app shell', () => {
  test('home page loads', async ({ page }) => {
    await page.goto('/')

    // App bar title + hero heading both render "Tong".
    await expect(page).toHaveTitle(/Tong/)
    await expect(page.getByRole('heading', { level: 1, name: 'Tong' })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Features' })).toBeVisible()
  })

  test('navigates between views via the nav drawer', async ({ page }) => {
    await page.goto('/')

    // The drawer sits in rail mode and expands on hover; hovering reveals the
    // full-width nav items. Scope to the left drawer (the right one is the
    // AgentPanel) so links here don't collide with the identically-named feature
    // cards in <main>.
    const nav = page.locator('nav.v-navigation-drawer--left')
    await nav.hover()

    await nav.getByRole('link', { name: 'Dictionary' }).click()
    await expect(page).toHaveURL(/\/dictionary$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Dictionary' })).toBeVisible()

    await nav.hover()
    await nav.getByRole('link', { name: 'Lexicon' }).click()
    await expect(page).toHaveURL(/\/lexicon$/)
    await expect(page.getByRole('heading', { level: 1, name: 'Lexicon' })).toBeVisible()
  })

  test('deep-links directly to a view', async ({ page }) => {
    await page.goto('/library')
    await expect(page.getByRole('heading', { level: 1, name: 'Library' })).toBeVisible()
  })
})
