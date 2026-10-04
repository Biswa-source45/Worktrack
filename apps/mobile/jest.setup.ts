// Set before any module loads so the api client binds to the mocked fetch and a fixed URL;
// tests never read the root .env.
process.env.EXPO_PUBLIC_API_URL = 'https://api.test';
process.env.EXPO_PUBLIC_APP_ENV = 'development';
global.fetch = jest.fn();

// Native modules are mocked at the module boundary; there is no real Keychain or Keystore in Jest.
jest.mock('expo-secure-store', () => jest.requireActual('./src/test/secure-store-mock'));
jest.mock('expo-device', () => ({
  modelName: 'Test Phone',
  deviceName: 'Test device',
  osName: 'iOS',
  osVersion: '27.0.1',
}));
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => '11111111-2222-3333-4444-555555555555'),
}));
jest.mock('expo-system-ui', () => ({ setBackgroundColorAsync: jest.fn(() => Promise.resolve()) }));
// No GPS in Jest: each test scripts the permission, the services switch and the position.
jest.mock('expo-location', () => ({
  Accuracy: { Highest: 5 },
  requestForegroundPermissionsAsync: jest.fn(),
  hasServicesEnabledAsync: jest.fn(),
  getCurrentPositionAsync: jest.fn(),
}));
