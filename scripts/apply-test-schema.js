// One-off: applies sql/schema.sql to whatever DATABASE_URL currently points
// at. Used before running the grading test suite against the disposable
// Docker test database — see
// docs/superpowers/specs/2026-09-08-grading-test-suite-design.md.
// Safe to re-run (schema.sql is entirely create-if-not-exists /
// add-column-if-not-exists).
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env.test') });

// Dynamic import: must run after dotenv.config() above sets DATABASE_URL,
// since ../src/config/db.js reads it at import time.
const { pool } = await import('../src/config/db.js');

async function main() {
  const schemaPath = path.join(__dirname, '..', 'sql', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  // Retry loop: right after `docker compose up`, Postgres can report
  // "starting" for a few seconds before actually accepting connections —
  // a single-attempt connect flakes intermittently in that window.
  const maxAttempts = 15;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query(schemaSql);
      console.log('Test schema applied.');
      await pool.end();
      return;
    } catch (err) {
      if (attempt === maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

main().catch((err) => {
  console.error('apply-test-schema failed:', err.message);
  process.exit(1);
});
