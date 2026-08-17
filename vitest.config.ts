import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
      /**
       * `server-only` throws on import by design — that is how it stops a client
       * component reaching server code, and it is why importing `uploads.ts`
       * from `Attachments.tsx` now fails the build loudly instead of producing
       * a webpack error about `node:path`.
       *
       * Tests run in Node, where that guard has nothing to protect, so it is
       * aliased to an empty module. Without this the file cannot be tested at
       * all, and its path-traversal checks are the last thing to leave untested.
       */
      'server-only': path.resolve(__dirname, './src/test/server-only-stub.ts'),
    },
  },
  test: {
    include: ['src/**/*.test.ts'],
  },
});
