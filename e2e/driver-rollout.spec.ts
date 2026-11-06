import { test, expect } from '@playwright/test';

test.describe('设备级 Go/Node 灰度', () => {
  test('管理员可切换并恢复 Auto', async ({ page }) => {
    await page.goto('/');
    await page.locator('input').first().fill('admin');
    await page.locator('input[type="password"]').first().fill('admin123');
    await page.getByRole('button', { name: /登录|登\s*录/i }).click();
    await expect(page.locator('nav')).toContainText('设备管理', { timeout: 10_000 });

    await page.getByRole('button', { name: '设备管理' }).click();
    const edit = page.locator('button[aria-label="编辑"]').first();
    await expect(edit).toBeVisible({ timeout: 10_000 });
    await edit.click();

    await expect(page).toHaveURL(/#\/devices\/[^?]+\?mode=edit/);
    await expect(page.getByText('设备级驱动灰度')).toBeVisible({ timeout: 10_000 });

    const go = page.getByRole('button', { name: 'Go', exact: true });
    const auto = page.getByRole('button', { name: '自动', exact: true });
    await expect(go).toBeEnabled();
    const [goResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/channels/s7-01/driver') && response.request().method() === 'PUT'),
      go.click(),
    ]);
    expect(goResponse.status()).toBe(200);
    await expect(go).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });

    const [autoResponse] = await Promise.all([
      page.waitForResponse((response) => response.url().includes('/api/channels/s7-01/driver') && response.request().method() === 'PUT'),
      auto.click(),
    ]);
    expect(autoResponse.status()).toBe(200);
    await expect(auto).toHaveAttribute('aria-pressed', 'true', { timeout: 10_000 });
  });
});
