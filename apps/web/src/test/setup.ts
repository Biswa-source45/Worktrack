import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, vi } from 'vitest';

// The network boundary is the only thing mocked; openapi-fetch captures this reference at import.
vi.stubGlobal('fetch', vi.fn());

afterEach(() => {
  cleanup();
  vi.mocked(fetch).mockReset();
});
