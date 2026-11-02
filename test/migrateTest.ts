import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'src', 'db', 'migrations');

/**
 * Every migration file in `src/db/migrations`, sorted exactly like the
 * production runner sorts them.
 *
 * Tests must never hard-code this list. A new migration that only exists in
 * production silently leaves the PGlite test database without the new column,
 * and every query touching it fails with a confusing "column does not exist"
 * that points at unrelated code.
 */
export async function listMigrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR)).filter((file) => file.endsWith('.sql')).sort();
}

/**
 * Reads one migration, stripping the pgcrypto extension line. PGlite builds do
 * not ship every extension, so migrations must be written to work without it.
 */
export async function readMigrationSql(file: string): Promise<string> {
  const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
  return sql.replace(/CREATE EXTENSION IF NOT EXISTS pgcrypto;\s*/g, '');
}

/** Applies every migration, in filename order, to an already-created PGlite. */
export async function applyAllMigrations(db: { exec(sql: string): Promise<unknown> }): Promise<void> {
  for (const file of await listMigrationFiles()) {
    await db.exec(await readMigrationSql(file));
  }
}
