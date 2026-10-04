import { initials } from './avatar';

describe('initials', () => {
  it.each([
    ['Asha Rao', 'AR'],
    ['asha', 'A'],
    ['  Biswa   Bhusan  Sahoo ', 'BS'],
    ['', ''],
  ])('%j gives %j', (name, expected) => {
    expect(initials(name)).toBe(expected);
  });
});
