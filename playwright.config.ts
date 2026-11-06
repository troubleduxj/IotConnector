import { defineConfig } from '@playwright/test';

/**
 * E2E 冒烟（A2 工程质量）：核心链路黑盒验证。
 * 前置：网关 8080 + 控制台 3001 已运行（本地演示栈）。
 * 运行：pnpm e2e（或 npx playwright test）
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3001',
    headless: true,
    channel: 'msedge', // 复用系统 Edge（免下载 Chromium，CDN 受限环境可用）
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'smoke', testMatch: /.*\.spec\.ts/ }],
});
