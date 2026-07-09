#!/usr/bin/env node
'use strict';

// Clear a login lockout from the command line (recovery for a fat-finger or
// attacker-induced lock, since the lock is now durable and a restart won't
// clear it). Usage:
//   npm run unlock          # clear lockout on all users
//   npm run unlock 2        # clear lockout on user id 2

const db = require('../src/db');

const arg = process.argv[2];
if (arg !== undefined) {
  const id = parseInt(arg, 10);
  if (!Number.isInteger(id) || id <= 0) {
    console.error(`Invalid user id: ${arg}`);
    process.exit(1);
  }
  const info = db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE id = ?').run(id);
  console.log(info.changes ? `Unlocked user ${id}.` : `No user with id ${id}.`);
} else {
  const info = db.prepare('UPDATE users SET failed_attempts = 0, locked_until = 0 WHERE locked_until > 0 OR failed_attempts > 0').run();
  console.log(`Cleared lockout state on ${info.changes} user(s).`);
}
