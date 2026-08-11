import { Router } from 'express';
import { pool } from '../config/db.js';
import { requireAuth, requireMaster } from '../middleware/auth.js';

export const masterBackupRouter = Router();

// Hardcoded whitelist of real, in-use tables — excludes rate_limits
// (ephemeral) and the confirmed-unused leftover parallel schema. See
// docs/superpowers/specs/2026-08-11-master-subsystem-f-design.md.
const TABLES = [
  'staff_roster',
  'manager_pins',
  'manager_credentials',
  'content',
  'results',
  'wrong_answers',
  'reports',
  'ai_results',
  'ai_wrong_answers',
  'ai_quizzes',
  'standard_questions',
  'master_users',
  'audit_log',
  'system_settings',
];

// Generic JS-value -> SQL-literal mapper. No per-table special-casing:
// covers every column type present across the 14 whitelisted tables
// (bigserial ids arrive as JS strings from node-pg and fall through to the
// string branch, which is fine — Postgres casts a quoted numeric literal to
// bigint automatically on INSERT).
function sqlLiteral(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return `'${value.toISOString()}'`;
  if (typeof value === 'object') {
    return `'${JSON.stringify(value).replace(/'/g, "''")}'::jsonb`;
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function buildDump() {
  const lines = [`-- Lautan Academy DB export — generated ${new Date().toISOString()}`, ''];
  for (const table of TABLES) {
    const { rows } = await pool.query(`select * from ${table}`);
    lines.push(`-- ${table} (${rows.length} rows)`);
    if (rows.length === 0) {
      lines.push('-- (empty)', '');
      continue;
    }
    const columns = Object.keys(rows[0]);
    const quotedColumns = columns.map((c) => `"${c}"`).join(', ');
    for (const row of rows) {
      const values = columns.map((c) => sqlLiteral(row[c])).join(', ');
      lines.push(`INSERT INTO ${table} (${quotedColumns}) VALUES (${values});`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

masterBackupRouter.get('/master/backup-export', requireAuth, requireMaster, async (req, res) => {
  const sql = await buildDump();
  const filename = `lautan-academy-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.sql`;
  res.setHeader('Content-Type', 'application/sql');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(sql);
});
