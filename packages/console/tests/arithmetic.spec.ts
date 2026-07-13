import { test, expect } from '@playwright/test';

test.describe('Arithmetic Input Tests', () => {
  test('evaluates arithmetic with commas correctly in MoneyInput', async ({ page }) => {
    // Navigate to login
    await page.goto('/login');
    await page.fill('input[name="username"]', 'manager');
    await page.fill('input[name="password"]', 'manager12345');
    await page.click('button[type="submit"]');

    // Wait for the login to complete
    await page.waitForTimeout(3000);

    // Navigate to products
    await page.goto('/products');

    // Click on Add product (Playwright auto-waits for it to be visible/clickable)
    await page.getByRole('button', { name: /Add product/i }).click();
    
    // Find Price (Rp) MoneyInput
    const priceInput = page.locator('label').filter({ hasText: 'Price (Rp)' }).locator('input').first();
    
    // Test 1: Typing an expression directly
    await priceInput.fill('');
    await priceInput.pressSequentially('1500+2000');
    await page.keyboard.press('Tab');
    
    // Check if the value evaluated to 3500 and formatted properly
    await expect(priceInput).toHaveValue('3,500');
    
    // Test 2: Another complex one
    await priceInput.fill('');
    await priceInput.pressSequentially('200*5.5');
    await page.keyboard.press('Tab');
    await expect(priceInput).toHaveValue('1,100');
    
    // Test 3: One with minus and parens
    await priceInput.fill('');
    await priceInput.pressSequentially('(10000-2000)/2');
    await page.keyboard.press('Tab');
    await expect(priceInput).toHaveValue('4,000');

    // Test 4: With explicit commas in the expression itself
    await priceInput.fill('');
    await priceInput.pressSequentially('1,500+2,500.50');
    await page.keyboard.press('Tab');
    // Result should be 4000.5 -> formatted to 4,000.50
    await expect(priceInput).toHaveValue('4,000.50');
  });
});
