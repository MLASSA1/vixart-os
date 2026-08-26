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

    /**
     * Integration tests share ONE database, so they must not run in parallel.
     *
     * Two concrete races, both observed rather than theorised:
     *
     *  - several files disable a global trigger during cleanup
     *    (ALTER TABLE document DISABLE TRIGGER document_immutable) to remove
     *    probe rows. Run concurrently, one file switches the guard off while
     *    another is asserting that it fires — so "an issued invoice cannot be
     *    modified" passed the UPDATE and failed the test. The same mechanism
     *    left invoice immutability off in the real database earlier in this
     *    project; here it is only a flaky test, but it is the same hazard.
     *
     *  - the append-only activity log is asserted by row count. Another file
     *    creating a task writes an activity row, and the count moves under the
     *    assertion.
     *
     * The unit tests are pure and would parallelise happily, but the whole
     * suite runs in about a second, so there is nothing to buy by splitting
     * them and a real guarantee to lose.
     */
    fileParallelism: false,
  },
});
