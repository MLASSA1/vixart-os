import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * The backup tells the truth, and the restore brings back everything.
 *
 * Both of these came out of a source audit, and both are the same shape: a
 * recovery path that reports success while doing nothing useful. That is the
 * worst class of defect this system can have, because the report is what anybody
 * would rely on — and by the time it matters, the evidence is gone.
 *
 * The backup test RUNS THE REAL SCRIPT with a stub `pg_dump`. A static check
 * would have passed on the broken version: the bug was not a missing line, it
 * was the exit status of a pipeline, and nothing you can grep for tells you
 * what `pg_dump | gzip` returns when the first half fails.
 */

const BACKUP = join(process.cwd(), 'scripts/backup.sh');
const RESTORE = join(process.cwd(), 'scripts/restore.sh');
const COMPOSE = join(process.cwd(), 'docker-compose.yml');

describe('the backup refuses to report a failure as success', () => {
  let dir = '';

  /** A throwaway BACKUP_DIR, a stub pg_dump on PATH, and one existing backup. */
  function stage(pgDump: string): { dir: string; env: NodeJS.ProcessEnv } {
    const root = mkdtempSync(join(tmpdir(), 'vixart-backup-'));
    mkdirSync(join(root, 'bin'));
    mkdirSync(join(root, 'backups'));
    mkdirSync(join(root, 'uploads'));
    writeFileSync(join(root, 'bin/pg_dump'), pgDump, { mode: 0o755 });
    chmodSync(join(root, 'bin/pg_dump'), 0o755);
    // A good backup already on disk — the one retention would prune to make
    // room for a bad new one.
    writeFileSync(join(root, 'backups/vixart_2026-01-01_000000.sql.gz'), 'kept');
    return {
      dir: root,
      env: {
        ...process.env,
        PATH: `${join(root, 'bin')}:${process.env.PATH ?? ''}`,
        BACKUP_DIR: join(root, 'backups'),
        BACKUP_RETENTION: '1',
        PGDATABASE: 'probe',
        UPLOADS_DIR: join(root, 'uploads'),
      },
    };
  }

  function run(env: NodeJS.ProcessEnv): { code: number; out: string } {
    try {
      const out = execFileSync('sh', [BACKUP], { env, encoding: 'utf8', stdio: 'pipe' });
      return { code: 0, out };
    } catch (error) {
      const e = error as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
    }
  }

  /**
   * Backups published by THIS run.
   *
   * The staged directory deliberately contains one pre-existing good backup —
   * the one retention would prune to make room for a bad new file — so counting
   * everything would always find it. The first version of this did, and reported
   * a failure as a publication.
   */
  const SEEDED = 'vixart_2026-01-01_000000.sql.gz';
  const published = (dir: string) =>
    readdirSync(join(dir, 'backups'))
      .filter((f) => /^vixart_\d/.test(f))
      .filter((f) => f !== SEEDED);

  afterAll(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('fails when the dump fails, and publishes nothing', () => {
    /*
     * The original defect, reproduced. `pg_dump | gzip` under `set -eu` returns
     * GZIP's status, and gzip succeeds on the empty stream it was handed — so a
     * failed dump produced exit 0, a published .sql.gz containing nothing, an
     * "OK" log line, and then retention pruned a real recovery point to make
     * room for it. Thirty nights of that leaves nothing to restore from and a
     * month of green logs behind it.
     */
    const staged = stage('#!/bin/sh\necho "connection failed" >&2\nexit 1\n');
    dir = staged.dir;
    const { code, out } = run(staged.env);

    expect(code, 'a failed dump still reported success').not.toBe(0);
    expect(out).toMatch(/FAILED/);
    expect(published(dir), 'a failed dump published a backup file').toEqual([]);
    // And the good one it would have pruned is still there.
    expect(existsSync(join(dir, 'backups', SEEDED)), 'retention pruned a good backup for a failed one').toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails when the dump is cut off halfway, even though pg_dump exited 0', () => {
    /*
     * The subtler half, and the reason an exit-status check alone is not enough:
     * a dump interrupted mid-table compresses to a perfectly valid gzip file
     * that restores a perfectly broken database. `gzip -t` says it is fine.
     * pg_dump's own completion marker is what says it is not.
     */
    const staged = stage(
      '#!/bin/sh\necho "-- PostgreSQL database dump"\necho "COPY \\"client\\" FROM stdin;"\necho "1\tHalf a row"\nexit 0\n',
    );
    dir = staged.dir;
    const { code, out } = run(staged.env);

    expect(code, 'a truncated dump was published as a good backup').not.toBe(0);
    expect(out).toMatch(/truncated|FAILED/i);
    expect(published(dir)).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it('succeeds on a complete dump, and the file has the dump inside it', () => {
    // The other direction: a guard that refused everything would pass both tests
    // above and take the backups with it.
    const staged = stage(
      '#!/bin/sh\necho "-- PostgreSQL database dump"\necho "CREATE TABLE \\"x\\" (id int);"\necho "-- PostgreSQL database dump complete"\nexit 0\n',
    );
    dir = staged.dir;
    const { code, out } = run(staged.env);

    expect(code, out).toBe(0);
    expect(out).toMatch(/OK —/);
    const files = published(dir);
    expect(files.length).toBeGreaterThan(0);

    // Not an empty gzip wearing a real name.
    const gz = readFileSync(join(dir, 'backups', files.find((f) => f.endsWith('.sql.gz'))!));
    expect(gz.length).toBeGreaterThan(20);
    rmSync(dir, { recursive: true, force: true });
  });

  it('never pipes the dump straight into gzip again', () => {
    // The shape of the original bug, named so a future tidy-up does not restore
    // it for brevity's sake.
    /*
     * Comments stripped first. This file explains the original bug at length and
     * quotes the broken pipeline in prose — so the first version of this guard
     * matched its own explanation and failed on the fixed script.
     */
    const code = readFileSync(BACKUP, 'utf8')
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n');

    expect(code, 'the dump is piped into gzip — the pipeline hides its failure')
      .not.toMatch(/pg_dump[\s\S]{0,400}\|\s*gzip/);
    expect(code).toContain('PostgreSQL database dump complete');
  });
});

describe('the restore brings back the files, and stops everything that writes', () => {
  const source = () => readFileSync(RESTORE, 'utf8');

  it('restores the paired file archive', () => {
    /*
     * It restored the database alone. The dump holds `attachment` rows and not
     * one byte of what they point at, so recovery produced a system that
     * believed it had every photograph and voice note and served a 410 for each.
     * The backup had always written the matching archive; nothing read it.
     */
    const text = source();
    expect(text, 'the restore ignores the uploaded files').toContain('vixart_files_');
    expect(text).toMatch(/tar -xzf/);
    // Paired by timestamp: a dump from Tuesday with files from Friday is a
    // third state that never existed.
    expect(text).toContain('FILE/#vixart_/vixart_files_');
  });

  it('stops the portal and the backup daemon, not only the app', () => {
    const text = source();
    expect(text).toMatch(/WRITERS="app portal backup"/);
    // And aborts rather than shrugging: a writer that will not stop means rows
    // are being written into a database about to be replaced.
    expect(text, 'a writer that refuses to stop is ignored').not.toMatch(/stop app >\/dev\/null 2>&1 \|\| true/);
    expect(text).toMatch(/Restore ABORTED/);
  });

  it('uses the production overlay', () => {
    // Plain `docker compose` reads the base file only, so on the server this
    // would stop and start containers under a different definition from the one
    // they were created with — in the middle of a restore.
    expect(source()).toContain('docker-compose.prod.yml');
  });
});

describe('both containers write to the same uploads volume', () => {
  /**
   * The portal had no uploads volume at all.
   *
   * `/app/uploads` was its own writable layer: created by the Dockerfile,
   * writable, and invisible from everywhere else. A client sending a photograph
   * would have written it there — unreadable by the staff container serving the
   * same attachment id, outside the archive the backup takes, and destroyed by
   * the next deploy, which force-recreates that container every time. The
   * database row would have survived with nothing behind it.
   *
   * Found by audit rather than in use, and only because nobody had sent one yet.
   */
  const compose = () => readFileSync(COMPOSE, 'utf8');

  /** The block of a named service, up to the next top-level service. */
  function service(name: string): string {
    const text = compose();
    const at = text.indexOf(`\n  ${name}:`);
    expect(at, `no ${name} service in docker-compose.yml`).toBeGreaterThan(-1);
    const next = text.slice(at + 3).search(/\n  [a-z][a-z_-]*:\n/);
    return next === -1 ? text.slice(at) : text.slice(at, at + 3 + next);
  }

  it('gives the portal the shared volume and the same storage root', () => {
    const portal = service('portal');
    expect(portal, 'the portal has no uploads volume — client files would be lost')
      .toMatch(/uploads:\/app\/uploads/);
    expect(portal, 'the portal has no UPLOADS_DIR').toContain('UPLOADS_DIR: /app/uploads');
  });

  it('gives the app the same one, so an attachment id means one set of bytes', () => {
    expect(service('app')).toMatch(/uploads:\/app\/uploads/);
  });

  it('keeps the backup container read-only on it', () => {
    // A backup process that cannot write to the files it archives is a property
    // worth keeping; the restore extracts through a one-off app container.
    expect(service('backup')).toMatch(/uploads:\/uploads:ro/);
  });
});
