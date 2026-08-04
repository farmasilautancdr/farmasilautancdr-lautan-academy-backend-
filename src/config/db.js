import dns from 'dns';
import net from 'net';
import pg from 'pg';
import { env } from './env.js';

// Supabase's DB hostname resolves to both an IPv4 and IPv6 address, and some
// hosts (Railway among them) have no IPv6 egress — pg-pool crashes the whole
// process with ENETUNREACH if it picks the IPv6 one. dns.setDefaultResultOrder
// alone isn't enough on Node 20+: Happy Eyeballs (autoSelectFamily, on by
// default since Node 20) still races both addresses regardless of resolver
// order. Disabling it forces a single connection attempt using the ordered
// (now IPv4-first) result instead of racing.
dns.setDefaultResultOrder('ipv4first');
net.setDefaultAutoSelectFamily(false);

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
