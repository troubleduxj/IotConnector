import { defineConfig } from '@playwright/test';

/**
 * E2E 冒烟（A2 工程质量）：核心链路黑盒验证。
 *
 * 两种运行方式：
 *   pnpm e2e:docker  自带网关、模拟器与浏览器，全部在容器里，CI 用这个（E4）。
 *   pnpm e2e         针对本机已运行的网关（E2E_BASE_URL，默认 http://localhost:3001），用系统 Edge。
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  retries: 0,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3001',
    headless: true,
    // 本机默认复用系统 Edge（免下载 Chromium）；容器与 CI 里设 E2E_BROWSER=chromium 用镜像自带的浏览器。
    channel: process.env.E2E_BROWSER === 'chromium' ? undefined : 'msedge',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'smoke', testMatch: /.*\.spec\.ts/ }],
});
