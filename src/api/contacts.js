'use strict';

const express = require('express');
const db = require('../db');

const router = express.Router();

const PHONE_RE = /^\+\d{7,15}$/;

// ──────────────────────────────────────────────────────────────────────────────
// Contacts
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/contacts
router.get('/contacts', (req, res) => {
  const userId = req.session.userId;
  const contacts = db.prepare('SELECT id, name, phone FROM contacts WHERE user_id = ? ORDER BY name').all(userId);
  return res.json(contacts);
});

// POST /api/contacts
router.post('/contacts', (req, res) => {
  const userId = req.session.userId;
  const { name, phone } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!phone || !PHONE_RE.test(String(phone))) {
    return res.status(400).json({ error: 'phone must be in international format, e.g. +919876543210' });
  }

  const info = db.prepare('INSERT INTO contacts (user_id, name, phone) VALUES (?, ?, ?)').run(
    userId, String(name).trim(), String(phone)
  );
  const contact = db.prepare('SELECT id, name, phone FROM contacts WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json(contact);
});

// PUT /api/contacts/:id
router.put('/contacts/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;

  const existing = db.prepare('SELECT id, name, phone FROM contacts WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Contact not found' });
  }

  const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
  const phone = req.body.phone !== undefined ? String(req.body.phone) : existing.phone;

  if (!name) {
    return res.status(400).json({ error: 'name must be non-empty' });
  }
  if (!PHONE_RE.test(phone)) {
    return res.status(400).json({ error: 'phone must be in international format, e.g. +919876543210' });
  }

  db.prepare('UPDATE contacts SET name = ?, phone = ? WHERE id = ? AND user_id = ?').run(name, phone, id, userId);
  const contact = db.prepare('SELECT id, name, phone FROM contacts WHERE id = ?').get(id);
  return res.json(contact);
});

// DELETE /api/contacts/:id
router.delete('/contacts/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;

  const existing = db.prepare('SELECT id FROM contacts WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Contact not found' });
  }

  db.prepare('DELETE FROM contacts WHERE id = ? AND user_id = ?').run(id, userId);
  return res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Groups
// ──────────────────────────────────────────────────────────────────────────────

// GET /api/groups
router.get('/groups', (req, res) => {
  const userId = req.session.userId;
  const groups = db.prepare(`
    SELECT g.id, g.name, COUNT(gc.contact_id) AS member_count
    FROM groups g
    LEFT JOIN group_contacts gc ON gc.group_id = g.id
    WHERE g.user_id = ?
    GROUP BY g.id
    ORDER BY g.name
  `).all(userId);
  return res.json(groups);
});

// POST /api/groups
router.post('/groups', (req, res) => {
  const userId = req.session.userId;
  const { name } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  const info = db.prepare('INSERT INTO groups (user_id, name) VALUES (?, ?)').run(userId, String(name).trim());
  const group = db.prepare('SELECT id, name FROM groups WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json({ ...group, member_count: 0 });
});

// PUT /api/groups/:id
router.put('/groups/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;

  const existing = db.prepare('SELECT id FROM groups WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const { name } = req.body;
  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }

  db.prepare('UPDATE groups SET name = ? WHERE id = ? AND user_id = ?').run(String(name).trim(), id, userId);
  const group = db.prepare(`
    SELECT g.id, g.name, COUNT(gc.contact_id) AS member_count
    FROM groups g
    LEFT JOIN group_contacts gc ON gc.group_id = g.id
    WHERE g.id = ?
    GROUP BY g.id
  `).get(id);
  return res.json(group);
});

// DELETE /api/groups/:id
router.delete('/groups/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;

  const existing = db.prepare('SELECT id FROM groups WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Group not found' });
  }

  db.prepare('DELETE FROM groups WHERE id = ? AND user_id = ?').run(id, userId);
  return res.json({ ok: true });
});

// GET /api/groups/:id/members
router.get('/groups/:id/members', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;

  const group = db.prepare('SELECT id FROM groups WHERE id = ? AND user_id = ?').get(id, userId);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const members = db.prepare(`
    SELECT c.id, c.name, c.phone
    FROM contacts c
    JOIN group_contacts gc ON gc.contact_id = c.id
    WHERE gc.group_id = ?
    ORDER BY c.name
  `).all(id);
  return res.json(members);
});

// POST /api/groups/:id/members
router.post('/groups/:id/members', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const { contactId } = req.body;

  const group = db.prepare('SELECT id FROM groups WHERE id = ? AND user_id = ?').get(id, userId);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  if (!contactId) {
    return res.status(400).json({ error: 'contactId is required' });
  }

  const contact = db.prepare('SELECT id FROM contacts WHERE id = ? AND user_id = ?').get(contactId, userId);
  if (!contact) {
    return res.status(404).json({ error: 'Contact not found' });
  }

  try {
    db.prepare('INSERT INTO group_contacts (group_id, contact_id) VALUES (?, ?)').run(id, contactId);
  } catch (e) {
    // Already a member (PRIMARY KEY constraint)
    return res.status(409).json({ error: 'Contact already in group' });
  }

  return res.status(201).json({ ok: true });
});

// DELETE /api/groups/:id/members/:contactId
router.delete('/groups/:id/members/:contactId', (req, res) => {
  const userId = req.session.userId;
  const { id, contactId } = req.params;

  const group = db.prepare('SELECT id FROM groups WHERE id = ? AND user_id = ?').get(id, userId);
  if (!group) {
    return res.status(404).json({ error: 'Group not found' });
  }

  const info = db.prepare('DELETE FROM group_contacts WHERE group_id = ? AND contact_id = ?').run(id, contactId);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'Contact not in group' });
  }

  return res.json({ ok: true });
});

module.exports = router;
