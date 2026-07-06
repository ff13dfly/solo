import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright Configuration for Focus E2E Tests
 * Uses real API calls to test against live backend with Qwen LLM
 */
export default defineConfig({
  testDir: './tests/e2e',
  
  // Extended timeout for real LLM API calls
  timeout: 60000,
  expect: {
    timeout: 30000,
  },
  
  // No retries for real API tests
  fullyParallel: false,
  retries: 0,
  workers: 1,
  
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['list']
  ],
  
  use: {
    // Use environment variable or default port
    baseURL: process.env.VITE_URL || 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'Mobile Chrome',
      use: { 
        ...devices['Pixel 5'],
        // Use system Chrome instead of Playwright's built-in Chromium
        channel: 'chrome',
      },
    },
  ],

  // Disable auto-start - require manual dev server start
  // webServer: {
  //   command: 'npm run dev',
  //   url: 'http://localhost:5173',
  //   reuseExistingServer: true,
  //   timeout: 30000,
  // },
});
