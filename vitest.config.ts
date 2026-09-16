import { defineConfig } from 'vitest/config';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Load the env files the way Next does, because otherwise the integration
 * tests do not run and nobody is told.
 *
 * `npm test` used to report a confident green with 142 of 226 tests skipped:
 * every integration file begins by trying to reach DATABASE_URL and quietly
 * calls `describe.skipIf` when it cannot. Vitest does not put .env files on
 * `process.env` — Vite only exposes VITE_-prefixed values, and to
 * `import.meta.env` — so a plain shell had no connection string and the whole
 * RLS half of the suite evaporated without a word.
 *
 * `.env.local` wins over `.env`: the committed one points at the Docker
 * hostname `db`, which resolves inside the container and nowhere else, and the
 * local override points the same names at 127.0.0.1. An explicit export still
 * beats both — a variable already set is never overwritten here.
 *
 * Tests still skip when there is genuinely no database, which is the case this
 * mechanism exists for. What they no longer do is skip on a machine where the
 * database is running perfectly well.
 */
function loadEnvFiles() {
  for (const file of ['.env.local', '.env']) {
    const full = path.resolve(__dirname, file);
    if (!existsSync(full)) continue;
    for (const line of readFileSync(full, 'utf8').split('\n')) {
      const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const key = match[1]!;
      if (process.env[key] !== undefined) continue;
      process.env[key] = match[2]!.trim().replace(/^["'](.*)["']$/, '$1');
    }
  }
}

loadEnvFiles();

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
