// In-memory stand-in for expo-secure-store, installed by jest.setup.ts.
const store = new Map<string, string>();

export const getItemAsync = jest.fn((key: string) => Promise.resolve(store.get(key) ?? null));
export const setItemAsync = jest.fn((key: string, value: string) => {
  store.set(key, value);
  return Promise.resolve();
});
export const deleteItemAsync = jest.fn((key: string) => {
  store.delete(key);
  return Promise.resolve();
});

export const secureStoreContents = () => Object.fromEntries(store);
export const resetSecureStore = () => store.clear();
