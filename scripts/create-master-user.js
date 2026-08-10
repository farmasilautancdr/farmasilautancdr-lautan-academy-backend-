// Interactive-only CLI to create or reset a Master User. Prompts instead
// of taking username/password as argv so the password never lands in
// shell history or a process listing. Re-running with the same username
// overwrites its password — same "overwrite is the reset path"
// convention as manager-register/rotate-master-pin. This is the ONLY way
// to create a Master User — no in-app UI exists by design (see the spec's
// "Decisions" section on why).
// Reads both answers off a persistent 'line' listener rather than
// readline/promises' sequential question()/question() — the promises
// version reliably hangs on the second question() once stdin is
// non-interactive (piped/redirected), a known Node quirk. This form works
// for both a real interactive terminal and piped input.
import { createInterface } from 'readline';
import { stdin, stdout } from 'process';
import bcrypt from 'bcrypt';
import { pool } from '../src/config/db.js';

function readTwoLines(rl) {
  return new Promise((resolve) => {
    const lines = [];
    rl.on('line', (line) => {
      lines.push(line);
      if (lines.length === 1) rl.question('Master password: ');
      if (lines.length === 2) {
        rl.close();
        resolve(lines);
      }
    });
    rl.question('Master username: ');
  });
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout, terminal: false });
  const [rawUsername, password] = await readTwoLines(rl);
  const username = rawUsername.trim();

  if (!username) throw new Error('Username cannot be empty.');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');

  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query(
    `insert into master_users (username, password_hash) values ($1, $2)
     on conflict (username) do update set password_hash = excluded.password_hash`,
    [username, passwordHash]
  );
  console.log(`Master user "${username}" created/updated.`);
  await pool.end();
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
