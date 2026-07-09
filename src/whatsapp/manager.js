// src/whatsapp/manager.js
'use strict';

const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');

// In-memory state per user session
const sessions = {};

// WA contacts per user — keyed by phone, persists across reconnects
const waContacts = {};

// Normalize a phone number for pairing: digits only, international (country
// code + number, no '+'). Returns null if it doesn't look like a real number.
function normalizePairPhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return (digits.length >= 8 && digits.length <= 15) ? digits : null;
}

async function startSession(userId, opts = {}) {
  if (sessions[userId]?.connected) return;

  // Also guard against concurrent calls while session is initializing
  if (sessions[userId]?.initializing) return;
  sessions[userId] = { socket: null, connected: false, qr: null, pairingCode: null, retrying: false, initializing: true };

  // Load persisted contacts from disk (survives server restarts)
  const contactsCachePath = path.join(process.cwd(), 'sessions', `user-${userId}`, 'wa-contacts.json');
  if (!waContacts[userId]) {
    try {
      waContacts[userId] = JSON.parse(fs.readFileSync(contactsCachePath, 'utf8'));
    } catch (_) {
      waContacts[userId] = {};
    }
  }

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } =
    await import('@whiskeysockets/baileys');

  const sessionDir = path.join(process.cwd(), 'sessions', `user-${userId}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: require('pino')({ level: 'silent' }),
  });

  sessions[userId].socket = sock;
  sessions[userId].initializing = false;

  sock.ev.on('creds.update', saveCreds);

  // Phone-number login: request an 8-char pairing code instead of scanning a QR.
  // Only when a phone was supplied and this session isn't already registered.
  const pairPhone = normalizePairPhone(opts.pairPhone);
  if (pairPhone && !sock.authState.creds.registered) {
    setTimeout(async () => {
      if (!sessions[userId] || sessions[userId].connected) return;
      try {
        const code = await sock.requestPairingCode(pairPhone);
        if (sessions[userId]) sessions[userId].pairingCode = code;
        console.log(`[WA] User ${userId}: pairing code issued`);
      } catch (err) {
        console.error(`[WA] User ${userId}: requestPairingCode failed:`, err.message);
      }
    }, 3000); // let the socket establish before requesting (avoids "connection closed")
  }

  sock.ev.on('contacts.upsert', (contacts) => {
    let added = 0;
    for (const c of contacts) {
      if (!c.id || !c.id.endsWith('@s.whatsapp.net')) continue;
      const name = c.notify || c.name || c.verifiedName || '';
      if (!name) continue;
      const phone = '+' + c.id.replace('@s.whatsapp.net', '');
      waContacts[userId][phone] = { name, phone };
      added++;
    }
    if (added > 0) {
      const total = Object.keys(waContacts[userId]).length;
      console.log(`[WA] User ${userId}: contacts.upsert +${added} (total: ${total})`);
      try { fs.writeFileSync(contactsCachePath, JSON.stringify(waContacts[userId])); } catch (_) {}
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      sessions[userId].qr = await qrcode.toDataURL(qr);
      sessions[userId].connected = false;
    }
    if (connection === 'open') {
      sessions[userId].connected = true;
      sessions[userId].qr = null;
      sessions[userId].pairingCode = null;
      console.log(`[WA] User ${userId} connected`);
      // Trigger app-state sync to populate contacts.upsert
      if (typeof sock.resyncAppState === 'function') {
        sock.resyncAppState(['regular', 'regular_high', 'regular_low', 'critical_block', 'critical_unblock_low'])
          .catch(() => {}); // non-fatal
      }
    }
    if (connection === 'close') {
      sessions[userId].connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[WA] User ${userId} disconnected (code ${code}), reconnect=${shouldReconnect}`);
      if (!shouldReconnect) {
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
        console.log(`[WA] User ${userId} session cleared — open dashboard to scan QR`);
      } else if (!sessions[userId].retrying) {
        sessions[userId].retrying = true;
        setTimeout(() => {
          if (!sessions[userId]) return;
          sessions[userId].retrying = false;
          startSession(userId);
        }, 5000);
      }
    }
  });
}

async function stopSession(userId) {
  const s = sessions[userId];
  if (!s) return;
  if (s.socket) {
    try { s.socket.ev.removeAllListeners(); } catch (_) {}  // Remove listeners before logout to prevent reconnect loops
    try { await s.socket.logout(); } catch (_) {}
    try { s.socket.end(); } catch (_) {}
  }
  delete sessions[userId];
}

async function sendText(userId, phone, message) {
  const s = sessions[userId];
  if (!s?.connected || !s.socket) return false;
  try {
    const jid = phone.replace(/^\+/, '') + '@s.whatsapp.net';
    await s.socket.sendMessage(jid, { text: message });
    return true;
  } catch (err) {
    console.error(`[WA] sendText failed for user ${userId} to ${phone}:`, err.message);
    return false;
  }
}

function getStatus(userId) {
  const s = sessions[userId];
  if (!s) return { connected: false };
  return { connected: s.connected, qr: s.qr || undefined, pairingCode: s.pairingCode || undefined };
}

function getWAContacts(userId) {
  return Object.values(waContacts[userId] || {});
}

async function resetAppState(userId) {
  // Delete app-state-sync-version-*.json files — forces Baileys to re-download
  // all app state patches on next connect, which fires contacts.upsert with full list
  const sessionDir = path.join(process.cwd(), 'sessions', `user-${userId}`);
  console.log(`[WA] User ${userId}: resetting app state to force contact re-sync`);

  // Stop session first
  await stopSession(userId);

  // Delete only the version files (not creds.json — that would log out the user)
  if (!fs.existsSync(sessionDir)) {
    console.log(`[WA] User ${userId}: no session dir found, starting fresh`);
  } else {
    try {
      const files = fs.readdirSync(sessionDir);
      for (const f of files) {
        // Only delete version markers — not keys (deleting keys breaks decryption)
        if (f.startsWith('app-state-sync-version-')) {
          fs.unlinkSync(path.join(sessionDir, f));
        }
      }
      console.log(`[WA] User ${userId}: app state cleared — reconnecting`);
    } catch (err) {
      console.error(`[WA] resetAppState error:`, err.message);
    }
  }

  // Reconnect — Baileys will now re-download full state and fire contacts.upsert
  startSession(userId).catch(err =>
    console.error(`[WA] Failed to restart session for user ${userId}:`, err.message)
  );
}

async function startAllSessions() {
  const db = require('../db');
  const users = db.prepare('SELECT id FROM users').all();
  for (const user of users) {
    startSession(user.id).catch(err =>
      console.error(`[WA] Failed to start session for user ${user.id}:`, err.message)
    );
  }
}

module.exports = { startSession, stopSession, sendText, getStatus, startAllSessions, getWAContacts, resetAppState, normalizePairPhone };
