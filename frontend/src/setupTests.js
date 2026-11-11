// Vitest setup.
//
// `globals: false` means there is no global `expect`, so jest-dom's matchers
// are registered through its Vitest entry point rather than its default one -
// the default build expects a global `expect` to already exist.
//
// The automatic cleanup that Testing Library does for you also looks for a
// global `afterEach`, so it is registered explicitly here. Without it, mounted
// trees leak from one test into the next.
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
