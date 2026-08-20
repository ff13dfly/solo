import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    // 扩展只能跑在 persistent context 里，多 worker 会各起一个 Chrome + 各装一份扩展，
    // 既慢又容易在 CI 上互相挤爆。这套用例本来就只有十几条，串行最省心。
    workers: 1,
    fullyParallel: false,
    reporter: [['list']],
    // 冷启动 Chrome + 注册 service worker 实测 2~5s，默认 30s 在慢机器上会假阴性。
    timeout: 60_000,
    expect: { timeout: 10_000 },
    use: { trace: 'retain-on-failure' },
});
