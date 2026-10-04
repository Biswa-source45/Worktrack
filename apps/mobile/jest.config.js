module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.ts'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    // The package's "react-native" export is an ES module the preset does not transform; its
    // CommonJS build next to it holds the same real icons.
    '^lucide-react-native/icons/(.*)$':
      '<rootDir>/../../node_modules/lucide-react-native/dist/cjs/icons/$1.js',
  },
  // On a cold Babel cache (every CI run) the first render in a file transforms React Native
  // lazily, inside that test's time budget: 10 s and more, against Jest's default of 5 s.
  testTimeout: 60_000,
};
