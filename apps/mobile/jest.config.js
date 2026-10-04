module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: { '^@/(.*)$': '<rootDir>/src/$1' },
  // On a cold Babel cache (every CI run) the first render in a file transforms React Native
  // lazily, inside that test's time budget: 10 s and more, against Jest's default of 5 s.
  testTimeout: 60_000,
};
