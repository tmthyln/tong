import { test, expect } from '@playwright/test'

// Project Gutenberg import. As with webpage import, the success path is mocked
// at the API boundary (the real route downloads the book and starts one ingest
// workflow per chapter — covered by vitest); validation hits the real route,
// which rejects non-Gutenberg URLs before any fetch or D1 write.
test.describe('import from Project Gutenberg', () => {
  test('rejects a non-Gutenberg URL via the real API and keeps the dialog open', async ({ page }) => {
    await page.goto('/library')
    await page.getByTestId('import-gutenberg-button').click()

    const dialog = page.getByRole('dialog')
    await expect(dialog.getByText('Import from Project Gutenberg')).toBeVisible()

    await page.getByTestId('import-gutenberg-input').locator('input').fill('https://example.com/ebooks/1')
    await page.getByTestId('import-gutenberg-submit').click()

    await expect(dialog.getByText(/Not a Project Gutenberg URL/)).toBeVisible()
    await expect(dialog).toBeVisible()
  })

  test('submits the book URL and reports the imported chapters', async ({ page }) => {
    let requestBody: unknown = null
    await page.route('**/api/library/gutenberg', async (route) => {
      requestBody = route.request().postDataJSON()
      await route.fulfill({
        status: 201,
        json: {
          message: 'Book imported and processing started',
          ebookId: 23962,
          title: '西遊記',
          author: "Cheng'en Wu",
          chapterCount: 100,
          alreadyExists: false,
          folderId: 4242,
          documentIds: Array.from({ length: 100 }, (_, i) => i + 1),
          skippedChapters: 0,
        },
      })
    })

    await page.goto('/library')
    await page.getByTestId('import-gutenberg-button').click()
    await page.getByTestId('import-gutenberg-input').locator('input').fill('https://gutenberg.org/ebooks/23962')
    const treeRefresh = page.waitForRequest(
      (req) => new URL(req.url()).pathname === '/api/library' && req.method() === 'GET'
    )
    await page.getByTestId('import-gutenberg-submit').click()

    await expect(page.getByText('Imported “西遊記” as 100 chapter documents. Processing started.')).toBeVisible()
    await treeRefresh
    await expect(page.getByRole('dialog')).toBeHidden()
    expect(requestBody).toEqual({ url: 'https://gutenberg.org/ebooks/23962', knowledgeScopeId: null })
  })
})
