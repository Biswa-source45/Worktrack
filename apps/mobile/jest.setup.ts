// Set before any module loads so the api client binds to the mocked fetch and a fixed URL;
// tests never read the root .env.
process.env.EXPO_PUBLIC_API_URL = 'https://api.test';
process.env.EXPO_PUBLIC_APP_ENV = 'development';
global.fetch = jest.fn();
