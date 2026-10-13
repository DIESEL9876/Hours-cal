// DOM matchers and cleanup for component tests (files marked `@vitest-environment jsdom`).
// Engine/storage tests run in the default Node environment and skip this.
import { afterEach, expect } from 'vitest';

if (typeof document !== 'undefined') {
  const matchers = await import('@testing-library/jest-dom/matchers');
  expect.extend(matchers);
  const { cleanup } = await import('@testing-library/react');
  afterEach(cleanup);
}
