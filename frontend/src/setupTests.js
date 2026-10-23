// Vitest setup. `globals: false` means Testing Library's automatic cleanup does
// not hook itself up (it looks for a global afterEach), so we register it here
// explicitly - otherwise mounted trees leak between tests.
import '@testing-library/jest-dom';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});