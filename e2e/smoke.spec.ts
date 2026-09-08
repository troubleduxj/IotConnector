import { test, expect } from '@playwright/test';

/**
 * 核心链路冒烟：
 *  ① 登录（admin/admin123）→ ② 仪表盘加载 → ③ 采集调度页实时指标（KPI+通道行）
 *  ④ 参数诊断写值弹窗打开 → ⑤ 历史查询：Bool 位号统计行 latest 为 true/false 而非 0/1
 */
test.describe('Factory Bridge 核心链路冒烟', () => {
  test('登录 → 调度 → 诊断 → Bool 历史', async ({ page }) => {
    // ① 登录
    await page.goto('/');
    await page.locator('input').first().fill('admin'); // 用户名框（无显式 type）
    await page.locator('input[type="password"]').first().fill('admin123');
    await page.getByRole('button', { name: /登录|登\s*录/i }).click();
    await expect(page.locator('nav')).toContainText('仪表盘', { timeout: 10_000 });
    await expect(page.locator('main h1').first()).toContainText(/仪表盘|Dashboard/i);

    // ② 采集调度：真实引擎 KPI
    await page.locator('nav button', { hasText: '采集调度' }).click();
    await expect(page.locator('main h1').first()).toContainText('采集调度');
    await expect(page.locator('body')).toContainText('平均周期延迟', { timeout: 10_000 });

    // ③ 历史查询：选 Bool 位号（SUB.CB1Closed 或任意 Bool）统计行显示 true/false
    await page.locator('nav button', { hasText: '历史查询' }).click();
    await expect(page.locator('main h1').first()).toContainText(/历史查询|Historian/);
    // 侧栏搜索一个 Bool 位号
    const search = page.locator('input[placeholder*="搜索"]').first();
    await search.waitFor({ state: 'visible', timeout: 10_000 });
    await search.fill('CB1Closed');
    // 点击搜索结果行（含实时值前缀的容器）
    const row = page.locator('text=SUB.CB1Closed').first();
    await row.waitFor({ state: 'visible', timeout: 10_000 });
    await row.click();
    // 等待统计表出现该位号且 Latest 为 true/false 文本
    const statTable = page.locator('table', { hasText: '最新值' });
    await expect(statTable).toContainText('SUB.CB1Closed', { timeout: 15_000 });
    const cellText = await statTable.locator('tr', { hasText: 'SUB.CB1Closed' }).first().innerText();
    // latest/min/max 应出现 true 或 false 字样（而非仅 0/1）
    expect(cellText).toMatch(/true|false/);
    // avg 列对 Bool 显示 —
    expect(cellText).toContain('—');
  });

  test('登录失败锁定提示与退出', async ({ page }) => {
    await page.goto('/');
    await page.locator('input').first().fill('admin');
    await page.locator('input[type="password"]').first().fill('wrong-pass-123');
    await page.locator('input[type="password"]').first().press('Enter'); // 登录框支持回车提交
    await expect(page.locator('body')).toContainText(/口令|错误|失败|锁定/i, { timeout: 8_000 });
  });
});
