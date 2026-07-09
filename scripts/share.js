#!/usr/bin/env node
'use strict';

// Starts the WhatsApp Scheduler server AND a Cloudflare Tunnel so it can be
// reached from any phone/browser over HTTPS. Auto-generates a SESSION_SECRET
// on first run. Prints the public URL prominently. Ctrl+C stops both.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const projectDir = path.join(__dirname, '..');
const envPath = path.join(projectDir, '.env');
const PORT = process.env.PORT || 3000;

// ── 1. Ensure .env has a strong SESSION_SECRET ──────────────────────────────
function ensureSessionSecret() {
  let env = '';
  try { env = fs.readFileSync(envPath, 'utf8'); } catch (_) { /* no .env yet */ }
  if (!/^SESSION_SECRET=.+/m.test(env)) {
    const secret = crypto.randomBytes(48).toString('hex');
    env += (env && !env.endsWith('\n') ? '\n' : '') + `SESSION_SECRET=${secret}\n`;
    fs.writeFileSync(envPath, env);
    console.log('[share] Generated a new SESSION_SECRET in .env');
  }
}

// ── 2. Check cloudflared is installed ───────────────────────────────────────
function checkCloudflared() {
  const which = spawnSync('which', ['cloudflared']);
  if (which.status !== 0) {
    console.error(`
╔════════════════════════════════════════════════════════════════╗
  cloudflared is not installed. Install it first:

  macOS:    brew install cloudflared
  Windows:  winget install --id Cloudflare.cloudflared
  Linux:    see https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/

  Then run  npm run share  again.
╚════════════════════════════════════════════════════════════════╝
`);
    process.exit(1);
  }
}

// ── 3. Launch server + tunnel ───────────────────────────────────────────────
function main() {
  ensureSessionSecret();
  checkCloudflared();

  console.log('[share] Starting server…');
  const server = spawn('node', [path.join(projectDir, 'src', 'server.js')], {
    cwd: projectDir,
    stdio: 'inherit',
    env: process.env,
  });

  // Give the server a moment to bind the port, then open the tunnel
  const tunnelDelay = setTimeout(() => {
    console.log('[share] Opening Cloudflare Tunnel…');
    const tunnel = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${PORT}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const printUrl = (buf) => {
      const text = buf.toString();
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        console.log(`
╔════════════════════════════════════════════════════════════════╗
  Your app is live! Open this on any phone or computer:

     ${match[0]}

  Share it with your father. Bookmark it on his phone.
  (This URL changes each time you restart — for a permanent URL,
   see the "Permanent URL" section in README.md)
╚════════════════════════════════════════════════════════════════╝
`);
      }
    };
    tunnel.stdout.on('data', printUrl);
    tunnel.stderr.on('data', printUrl); // cloudflared prints the URL to stderr

    const shutdown = () => {
      tunnel.kill();
      server.kill();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    tunnel.on('exit', () => server.kill());
  }, 2500);

  server.on('exit', (code) => {
    clearTimeout(tunnelDelay);
    console.log(`[share] Server exited (code ${code})`);
    process.exit(code || 0);
  });
}

main();
