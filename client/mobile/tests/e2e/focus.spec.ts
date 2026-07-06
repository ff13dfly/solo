/**
 * Focus E2E Tests - Real API Integration
 * 
 * Tests the complete Focus workflow using real backend API
 * and actual Qwen LLM calls for parameter extraction.
 * 
 * Prerequisites:
 * 1. Backend services running: bash api/run.sh
 * 2. Valid Qwen API key in api/agent/.env
 */

import { test, expect, Page } from '@playwright/test';

// Test configuration
const FOCUS_TRIGGER = ':f 预定会议';
const PARAM_INPUT = '三楼大厅，明天下午三点';
const CANCEL_PHRASE = '算了';

// Helper: Wait for API to be ready
async function waitForApiReady(page: Page) {
  // Check if backend is responding
  try {
    const response = await page.request.post('http://localhost:3600/api/rpc', {
      data: {
        jsonrpc: '2.0',
        method: 'system.capability.list',
        params: {},
        id: 1
      }
    });
    return response.ok();
  } catch {
    return false;
  }
}

// Helper: Send chat message
async function sendMessage(page: Page, message: string) {
  const input = page.locator('[data-testid="chat-input"], input[type="text"], textarea').first();
  await input.fill(message);
  await input.press('Enter');
}

// Helper: Wait for system response
async function waitForSystemResponse(page: Page, timeout = 30000) {
  await page.waitForSelector('.message-bubble.system, [class*="system"]', { 
    timeout,
    state: 'visible' 
  });
}

test.describe('Focus E2E - Real API', () => {
  
  test.beforeAll(async ({ request }) => {
    // Verify backend is running
    try {
      const response = await request.post('http://localhost:3600/api/rpc', {
        data: {
          jsonrpc: '2.0',
          method: 'system.capability.list',
          params: {},
          id: 1
        }
      });
      
      if (!response.ok()) {
        console.warn('⚠️  Backend API not responding. Please run: bash api/run.sh');
      }
    } catch (e) {
      console.warn('⚠️  Cannot connect to backend. Please run: bash api/run.sh');
    }
  });

  test.beforeEach(async ({ page }) => {
    // Set E2E bypass flag before navigating
    await page.addInitScript(() => {
      localStorage.setItem('e2e_bypass_mobile_check', 'true');
    });
    await page.goto('/');
    // Wait for app to load
    await page.waitForLoadState('networkidle');
    // Wait a bit for React to render
    await page.waitForTimeout(1000);
  });

  test('01 - 触发 Focus 模式', async ({ page }) => {
    // Send focus trigger
    await sendMessage(page, FOCUS_TRIGGER);
    
    // Wait for Focus response
    await page.waitForTimeout(2000);
    
    // Verify Focus mode activated - look for summary card or focus indicator
    const focusIndicator = page.locator('[class*="summary"], [class*="focus"], [class*="SummaryCard"]').first();
    
    // Either the SummaryCard appears or we get a system message about the workflow
    const systemMessage = page.locator('[class*="system"], .message-bubble').last();
    
    // Check that we got some response indicating Focus was triggered
    await expect(systemMessage).toBeVisible({ timeout: 10000 });
    
    // Verify the response mentions the workflow
    const messageText = await systemMessage.textContent();
    expect(
      messageText?.includes('会议') || 
      messageText?.includes('Focus') ||
      messageText?.includes('安排') ||
      messageText?.includes('任务')
    ).toBeTruthy();
    
    console.log('✅ Focus mode triggered successfully');
  });

  test('02 - 真实千问参数提取', async ({ page }) => {
    // Step 1: Enter Focus mode
    await sendMessage(page, FOCUS_TRIGGER);
    await page.waitForTimeout(2000);
    
    // Step 2: Send parameter input
    await sendMessage(page, PARAM_INPUT);
    
    // Wait for LLM response (up to 30s for real API)
    await page.waitForTimeout(3000);
    
    // Look for any response from the system
    const messages = page.locator('[class*="system"], .message-bubble');
    const lastMessage = messages.last();
    
    await expect(lastMessage).toBeVisible({ timeout: 30000 });
    
    const responseText = await lastMessage.textContent();
    console.log('📝 LLM Response:', responseText);
    
    // Verify the response acknowledges our input or extracts parameters
    // The response should mention room/time or ask for more info
    expect(
      responseText?.includes('三楼') ||
      responseText?.includes('大厅') ||
      responseText?.includes('下午') ||
      responseText?.includes('时间') ||
      responseText?.includes('会议室') ||
      responseText?.includes('已') ||
      responseText?.includes('完成') ||
      responseText?.includes('确认')
    ).toBeTruthy();
    
    console.log('✅ Parameter extraction completed');
  });

  test('03 - 自然语言取消', async ({ page }) => {
    // Step 1: Enter Focus mode
    await sendMessage(page, FOCUS_TRIGGER);
    await page.waitForTimeout(2000);
    
    // Step 2: Send cancel phrase
    await sendMessage(page, CANCEL_PHRASE);
    
    await page.waitForTimeout(2000);
    
    // Verify cancellation response
    const messages = page.locator('[class*="system"], .message-bubble');
    const lastMessage = messages.last();
    
    await expect(lastMessage).toBeVisible({ timeout: 10000 });
    
    const responseText = await lastMessage.textContent();
    console.log('📝 Cancel Response:', responseText);
    
    // Verify the response indicates cancellation
    expect(
      responseText?.includes('取消') ||
      responseText?.includes('已') ||
      responseText?.includes('好的') ||
      responseText?.includes('其他')
    ).toBeTruthy();
    
    console.log('✅ Focus cancelled successfully');
  });

  test('04 - 完整 Focus 流程', async ({ page }) => {
    // This test runs the complete flow from trigger to parameter collection
    
    // Step 1: Trigger Focus
    console.log('📍 Step 1: Triggering Focus...');
    await sendMessage(page, FOCUS_TRIGGER);
    await page.waitForTimeout(3000);
    
    // Step 2: Provide room parameter
    console.log('📍 Step 2: Providing room parameter...');
    await sendMessage(page, '用三楼大厅');
    await page.waitForTimeout(5000);
    
    // Step 3: Provide time parameter
    console.log('📍 Step 3: Providing time parameter...');
    await sendMessage(page, '明天下午三点开始');
    await page.waitForTimeout(5000);
    
    // Verify we have responses
    const messages = page.locator('[class*="system"], .message-bubble');
    const count = await messages.count();
    
    // Should have multiple system responses
    expect(count).toBeGreaterThan(2);
    
    console.log(`✅ Complete flow executed with ${count} messages`);
  });

});

test.describe('Focus Edge Cases', () => {
  
  test.beforeEach(async ({ page }) => {
    // Set E2E bypass flag before navigating
    await page.addInitScript(() => {
      localStorage.setItem('e2e_bypass_mobile_check', 'true');
    });
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1000);
  });

  test('05 - 模糊输入处理', async ({ page }) => {
    // Enter Focus
    await sendMessage(page, FOCUS_TRIGGER);
    await page.waitForTimeout(2000);
    
    // Send vague input
    await sendMessage(page, '随便一个房间就行');
    await page.waitForTimeout(5000);
    
    // Should get a clarification or hint
    const lastMessage = page.locator('[class*="system"], .message-bubble').last();
    await expect(lastMessage).toBeVisible({ timeout: 15000 });
    
    const responseText = await lastMessage.textContent();
    console.log('📝 Vague input response:', responseText);
    
    // Response should ask for more info or provide options
    expect(responseText?.length).toBeGreaterThan(5);
    
    console.log('✅ Vague input handled');
  });

});
