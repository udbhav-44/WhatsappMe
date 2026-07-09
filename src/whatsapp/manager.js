// src/whatsapp/manager.js
'use strict';

const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');

// In-memory state per user session
// sessions[userId] = { socket: null, connected: false, qr: null, retrying: false }
const sessions = {};

// WA contact list per user (populated on contacts.upsert event)
// waContacts[userId] = [{ name, phone }]
const waContacts = {};

async function startSession(userId) {
  if (sessions[userId]?.connected) return; // already connected

  sessions[userId] = { socket: null, connected: false, qr: null, retrying: false };

  const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } =
    await import('@whiskeysockets/baileys');

  const sessionDir = path.join(process.cwd(), 'sessions', `user-${userId}`);
  fs.mkdirSync(sessionDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false, // we handle QR ourselves
    logger: require('pino')({ level: 'silent' }), // suppress Baileys logs
  });

  sessions[userId].socket = sock;

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('contacts.upsert', (contacts) => {
    if (!waContacts[userId]) waContacts[userId] = [];
    for (const c of contacts) {
      if (!c.id || !c.id.endsWith('@s.whatsapp.net')) continue; // skip groups
      const phone = '+' + c.id.replace('@s.whatsapp.net', '');
      const name = c.notify || c.name || c.verifiedName || '';
      if (!name) continue; // skip nameless entries
      // upsert by phone
      const existing = waContacts[userId].findIndex(x => x.phone === phone);
      if (existing >= 0) waContacts[userId][existing] = { name, phone };
      else waContacts[userId].push({ name, phone });
    }
  });

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // Convert QR string to data URL for browser display
      sessions[userId].qr = await qrcode.toDataURL(qr);
      sessions[userId].connected = false;
    }
    if (connection === 'open') {
      sessions[userId].connected = true;
      sessions[userId].qr = null;
      console.log(`[WA] User ${userId} connected`);
    }
    if (connection === 'close') {
      sessions[userId].connected = false;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`[WA] User ${userId} disconnected (code ${code}), reconnect=${shouldReconnect}`);
      if (!shouldReconnect) {
        // Logged out — clear stale session files so next startSession shows QR
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
        console.log(`[WA] User ${userId} session cleared — open dashboard to scan QR`);
      } else if (!sessions[userId].retrying) {
        sessions[userId].retrying = true;
        setTimeout(() => {
          if (!sessions[userId]) return;
          sessions[userId].retrying = false;
          startSession(userId); // reconnect
        }, 5000);
      }
    }
  });
}

async function stopSession(userId) {
  const s = sessions[userId];
  if (!s) return;
  if (s.socket) {
    try { await s.socket.logout(); } catch (_) {}
    try { s.socket.end(); } catch (_) {}
  }
  delete sessions[userId];
}

async function sendText(userId, phone, message) {
  const s = sessions[userId];
  if (!s?.connected || !s.socket) return false;
  try {
    // phone: "+919876543210" → "919876543210@s.whatsapp.net"
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
  return { connected: s.connected, qr: s.qr || undefined };
}

// Auto-start all existing users on server boot
async function startAllSessions() {
  const db = require('../db');
  const users = db.prepare('SELECT id FROM users').all();
  for (const user of users) {
    startSession(user.id).catch(err =>
      console.error(`[WA] Failed to start session for user ${user.id}:`, err.message)
    );
  }
}

function getWAContacts(userId) {
  return waContacts[userId] || [];
}

module.exports = { startSession, stopSession, sendText, getStatus, startAllSessions, getWAContacts };
