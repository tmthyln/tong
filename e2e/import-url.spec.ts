import { test, expect } from '@playwright/test'

// Webpage import (issue #8). The success path is mocked at the API boundary —
// the real route fetches from the internet and kicks off the ingest workflow
// (which needs remote AI bindings), so it is covered by vitest instead. The
// validation path hits the real Worker route: it rejects before any fetch or
// D1 write, so it runs offline.
test.describe('import webpage by URL', () => {
  test('rejects private URLs via the real API and keeps the dialog open', async ({ page }) => {
    await page.goto('/library')
    await page.getByTestId('import-url-button').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Import Webpage')).toBeVisible()

    await page.getByTestId('import-url-input').locator('input').fill('http://127.0.0.1/secret')
    await page.getByTestId('import-url-submit').click()

    await expect(dialog.getByText(/local or private addresses/)).toBeVisible()
    await expect(dialog).toBeVisible()
  })

  test('submits the URL and reports success', async ({ page }) => {
    let requestBody: unknown = null
    await page.route('**/api/library/document/url', async (route) => {
      requestBody = route.request().postDataJSON()
      await route.fulfill({
        status: 201,
        json: {
          message: 'Webpage imported and processing started',
          documentId: 999,
          workflowId: 'wf',
          alreadyExists: false,
        },
      })
    })

    await page.goto('/library')
    await page.getByTestId('import-url-button').click()
    await page.getByTestId('import-url-input').locator('input').fill('https://example.com/article')
    // A root-level import must refresh the directory tree too (it lists root documents).
    const treeRefresh = page.waitForRequest(
      (req) => new URL(req.url()).pathname === '/api/library' && req.method() === 'GET'
    )
    await page.getByTestId('import-url-input').locator('input').press('Enter')

    await expect(page.getByText('Webpage imported. Processing started.')).toBeVisible()
    await treeRefresh
    await expect(page.getByRole('dialog')).toBeHidden()
    expect(requestBody).toEqual({ url: 'https://example.com/article', folderId: null })
  })
})
