// src/whatsapp/manager.js
'use strict';

const path = require('path');
const fs = require('fs');
const qrcode = require('qrcode');

// In-memory state per user session
const sessions = {};

// WA contacts per user — keyed by phone, persists across reconnects
const waContacts = {};

async function startSession(userId) {
  if (sessions[userId]?.connected) return;

  sessions[userId] = { socket: null, connected: false, qr: null, retrying: false };
  if (!waContacts[userId]) waContacts[userId] = {};

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

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('contacts.upsert', (contacts) => {
    for (const c of contacts) {
      if (!c.id || !c.id.endsWith('@s.whatsapp.net')) continue;
      const name = c.notify || c.name || c.verifiedName || '';
      if (!name) continue;
      const phone = '+' + c.id.replace('@s.whatsapp.net', '');
      waContacts[userId][phone] = { name, phone };
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
      console.log(`[WA] User ${userId} connected`);
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
  return { connected: s.connected, qr: s.qr || undefined };
}

function getWAContacts(userId) {
  return Object.values(waContacts[userId] || {});
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

module.exports = { startSession, stopSession, sendText, getStatus, startAllSessions, getWAContacts };
