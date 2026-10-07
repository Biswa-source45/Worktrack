import { expect, test, type Page } from '@playwright/test';
import { goTo, uiLoginAsReadyAdmin } from './helpers';

const noHorizontalScroll = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);

test('the sidebar collapses to an icon rail and stays collapsed after a reload', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await uiLoginAsReadyAdmin(page);
  const nav = page.getByRole('navigation');
  await expect(nav.getByRole('link', { name: 'Employees' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeHidden();
  const width = () => page.locator('aside').evaluate((el) => el.getBoundingClientRect().width);
  expect(await width()).toBe(240);

  await page.getByRole('button', { name: 'Collapse sidebar' }).click();
  await expect.poll(width).toBe(64);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Expand sidebar' })).toBeVisible();
  expect(await width()).toBe(64);

  // The rail still navigates, and the current page keeps its marker.
  await goTo(page, 'Devices');
  await expect(page).toHaveURL(/\/devices$/);
  await expect(nav.getByRole('link', { name: 'Devices' })).toHaveAttribute('aria-current', 'page');
  await page.getByRole('button', { name: 'Expand sidebar' }).click();
  await expect.poll(width).toBe(240);
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('below 1024px the sidebar is a drawer that closes on Escape and on a tap on a link', async ({
  page,
}) => {
  await page.setViewportSize({ width: 768, height: 800 });
  await uiLoginAsReadyAdmin(page);
  await expect(page.getByRole('navigation')).toBeHidden();
  expect(await noHorizontalScroll(page)).toBe(true);

  await page.getByRole('button', { name: 'Open menu' }).click();
  const drawer = page.getByRole('dialog', { name: 'Menu' });
  await expect(drawer.getByRole('link', { name: 'Sessions' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();

  await goTo(page, 'Sessions');
  await expect(page).toHaveURL(/\/sessions$/);
  await expect(drawer).toBeHidden();
  expect(await noHorizontalScroll(page)).toBe(true);
});
