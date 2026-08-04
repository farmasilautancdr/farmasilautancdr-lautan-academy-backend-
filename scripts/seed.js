// Usage:
//   node scripts/seed.js staff <division> <outlet> <name> <pin> [addedBy]
//   node scripts/seed.js manager <role> <pin>
//
// role is one of: outlet_manager, warehouse_manager, area_manager, supervisor, resources
import 'dotenv/config';
import bcrypt from 'bcrypt';
import pg from 'pg';
import { env } from '../src/config/env.js';

const pool = new pg.Pool({ connectionString: env.databaseUrl, ssl: { rejectUnauthorized: false } });

async function seedStaff(division, outlet, name, pin, addedBy) {
  const pinHash = await bcrypt.hash(pin, 10);
  await pool.query(
    `insert into staff_roster (division, outlet, name, pin_hash, added_by)
     values ($1, $2, $3, $4, $5)
     on conflict (division, outlet, name) do update set pin_hash = excluded.pin_hash, added_by = excluded.added_by`,
    [division.toLowerCase().trim(), outlet.toUpperCase().trim(), name.toUpperCase().trim(), pinHash, addedBy || null]
  );
  console.log(`Seeded staff: ${division}/${outlet}/${name}`);
}

async function seedManager(role, pin) {
  const validRoles = ['outlet_manager', 'warehouse_manager', 'area_manager', 'supervisor', 'resources'];
  if (!validRoles.includes(role)) throw new Error(`Unknown role "${role}". Valid: ${validRoles.join(', ')}`);
  const pinHash = await bcrypt.hash(pin, 10);
  await pool.query(
    `insert into manager_pins (role, pin_hash) values ($1, $2)
     on conflict (role) do update set pin_hash = excluded.pin_hash`,
    [role, pinHash]
  );
  console.log(`Seeded manager PIN: ${role}`);
}

async function main() {
  const [, , kind, ...args] = process.argv;
  if (kind === 'staff') {
    const [division, outlet, name, pin, addedBy] = args;
    if (!division || !outlet || !name || !pin) {
      throw new Error('Usage: node scripts/seed.js staff <division> <outlet> <name> <pin> [addedBy]');
    }
    await seedStaff(division, outlet, name, pin, addedBy);
  } else if (kind === 'manager') {
    const [role, pin] = args;
    if (!role || !pin) {
      throw new Error('Usage: node scripts/seed.js manager <role> <pin>');
    }
    await seedManager(role, pin);
  } else {
    throw new Error('First argument must be "staff" or "manager".');
  }
  await pool.end();
}

main().catch(e => {
  console.error(e.message);
  process.exit(1);
});
