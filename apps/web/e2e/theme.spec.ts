import { expect, test, type Page } from '@playwright/test';
import { uiLoginAsReadyAdmin } from './helpers';

const themeButton = (page: Page, name: 'Light' | 'Dark' | 'System') =>
  page.getByRole('group', { name: 'Theme' }).getByRole('button', { name, exact: true });
const isDark = (page: Page) =>
  page.evaluate(() => document.documentElement.classList.contains('dark'));
const stored = (page: Page) => page.evaluate(() => localStorage.getItem('wt-theme'));

// Records the theme class on the first frame in which the body can paint. Registered before
// any page script, so a theme applied late (after hydration) would be caught as a flash.
async function probeFirstFrame(page: Page) {
  await page.addInitScript(() => {
    const probe = () => {
      if (!document.body) return requestAnimationFrame(probe);
      (window as unknown as { firstFrameDark: boolean }).firstFrameDark =
        document.documentElement.classList.contains('dark');
    };
    requestAnimationFrame(probe);
  });
}
const firstFrameDark = (page: Page) =>
  page.evaluate(() => (window as unknown as { firstFrameDark: boolean }).firstFrameDark);

test('the theme follows the system by default, and a choice survives a reload without a flash', async ({
  page,
}) => {
  await probeFirstFrame(page);

  // Default is System: it follows the browser, from the very first frame and live.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/login');
  expect(await stored(page)).toBeNull();
  expect(await firstFrameDark(page)).toBe(true);
  await expect(themeButton(page, 'System')).toHaveAttribute('aria-pressed', 'true');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect.poll(() => isDark(page)).toBe(false);

  // Choose Dark on the login page while the system is light.
  await themeButton(page, 'Dark').click();
  await expect.poll(() => isDark(page)).toBe(true);
  expect(await stored(page)).toBe('dark');
  await expect(themeButton(page, 'Dark')).toHaveAttribute('aria-pressed', 'true');

  await page.reload();
  expect(await firstFrameDark(page)).toBe(true);
  expect(await isDark(page)).toBe(true);
  await expect(themeButton(page, 'Dark')).toHaveAttribute('aria-pressed', 'true');

  // The choice carries into the signed-in pages, where the header has the same control.
  await uiLoginAsReadyAdmin(page);
  expect(await firstFrameDark(page)).toBe(true);
  await expect(themeButton(page, 'Dark')).toHaveAttribute('aria-pressed', 'true');

  // Choose Light while the system is dark: no dark flash on reload.
  await page.emulateMedia({ colorScheme: 'dark' });
  await themeButton(page, 'Light').click();
  await expect.poll(() => isDark(page)).toBe(false);
  expect(await stored(page)).toBe('light');
  await page.reload();
  expect(await firstFrameDark(page)).toBe(false);
  await expect(themeButton(page, 'Light')).toHaveAttribute('aria-pressed', 'true');

  // Back to System: follows the (dark) system again.
  await themeButton(page, 'System').click();
  await expect.poll(() => isDark(page)).toBe(true);
  expect(await stored(page)).toBe('system');
});

test('a password can be shown and hidden without submitting the form', async ({ page }) => {
  await page.goto('/login');
  const password = page.getByLabel('Password', { exact: true });
  await password.fill('not-a-real-password');
  await expect(password).toHaveAttribute('type', 'password');
  await expect(password).toHaveAttribute('autocomplete', 'current-password');

  const show = page.getByRole('button', { name: 'Show password' });
  await expect(show).toHaveAttribute('aria-pressed', 'false');
  await show.click();
  await expect(password).toHaveAttribute('type', 'text');
  await expect(password).toHaveValue('not-a-real-password');
  const hide = page.getByRole('button', { name: 'Hide password' });
  await expect(hide).toHaveAttribute('aria-pressed', 'true');

  // Keyboard: the toggle is the next stop after the input and works with Enter.
  await password.focus();
  await page.keyboard.press('Tab');
  await expect(hide).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(password).toHaveAttribute('type', 'password');

  // Nothing was submitted: still on the login page with no error shown.
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.locator('form [role="alert"]')).toHaveCount(0);
});
