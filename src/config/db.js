import dns from 'dns';
import pg from 'pg';
import { env } from './env.js';

// Supabase's DB hostname resolves to both an IPv4 and IPv6 address, and some
// hosts (Railway among them) have no IPv6 egress — pg-pool crashes the whole
// process with ENETUNREACH if it happens to pick the IPv6 one. Forcing
// IPv4-first here is a Node 18+ resolver setting, not a Supabase-specific
// connection-string workaround, so it holds regardless of host.
dns.setDefaultResultOrder('ipv4first');

export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  ssl: { rejectUnauthorized: false },
});

// pg.Pool crashes the whole process on an unhandled 'error' event (e.g. an
// idle client dropped by the server) — this is the documented way to avoid
// that: log it, keep serving requests on the rest of the pool.
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});
