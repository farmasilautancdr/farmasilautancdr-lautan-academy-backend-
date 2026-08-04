// Syncs the Content (Knowledge Base) table from GAS. Safe to re-run — unlike
// migrate-from-gas.js, `content` isn't written to by this backend yet (no
// UI/endpoint writes to it outside this script and the not-yet-built
// Supervisor content-management UI), so a full truncate+reload here can't
// lose anything this backend itself created.
import 'dotenv/config';
import pg from 'pg';
import { env } from '../src/config/env.js';

const GAS_URL = process.env.GAS_URL;
const SUPERVISOR_PIN = process.env.SUPERVISOR_PIN;
if (!GAS_URL) throw new Error('GAS_URL is not set in .env');
if (!SUPERVISOR_PIN) throw new Error('SUPERVISOR_PIN is not set in .env');

const pool = new pg.Pool({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });

async function gasPost(body) {
  const res = await fetch(GAS_URL, { method: 'POST', body: JSON.stringify(body) });
  return res.json();
}

async function main() {
  console.log('Logging in as Supervisor...');
  const login = await gasPost({ action: 'establish_session', role: 'supervisor', outlet: '', pin: SUPERVISOR_PIN });
  if (!login.authorized) throw new Error('Supervisor login failed: ' + (login.error || 'unknown'));

  console.log('Fetching content...');
  const data = await gasPost({ action: 'get_scoped_data', token: login.token, windowMonths: 0 });
  if (!data.authorized) throw new Error('get_scoped_data failed: ' + (data.error || 'unknown'));
  const content = data.content || [];
  console.log(`Pulled ${content.length} content rows.`);

  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('truncate content');
    for (const c of content) {
      await client.query(
        `insert into content (topic, category, title, body, link, created_at) values ($1,$2,$3,$4,$5,$6)`,
        [c.Topic || '', c.Category || '', c.Title || '', c.Body || '', c.Link || '', c.Timestamp ? new Date(c.Timestamp) : new Date()]
      );
    }
    await client.query('commit');
    console.log('Content sync committed.');
  } catch (e) {
    await client.query('rollback');
    throw e;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch(e => {
  console.error('Content sync failed:', e.message);
  process.exit(1);
});
