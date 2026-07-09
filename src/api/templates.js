'use strict';

const express = require('express');
const db = require('../db');
const { render } = require('../templates/renderer');

const router = express.Router();

// GET /api/templates
router.get('/templates', (req, res) => {
  const userId = req.session.userId;
  const templates = db.prepare('SELECT id, name, body FROM templates WHERE user_id = ? ORDER BY name').all(userId);
  return res.json(templates);
});

// POST /api/templates
router.post('/templates', (req, res) => {
  const userId = req.session.userId;
  const { name, body } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  if (!body || !String(body).trim()) {
    return res.status(400).json({ error: 'body is required' });
  }

  const info = db.prepare('INSERT INTO templates (user_id, name, body) VALUES (?, ?, ?)').run(
    userId, String(name).trim(), String(body)
  );
  const template = db.prepare('SELECT id, name, body FROM templates WHERE id = ?').get(info.lastInsertRowid);
  return res.status(201).json(template);
});

// PUT /api/templates/:id
router.put('/templates/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;

  const existing = db.prepare('SELECT id, name, body FROM templates WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const name = req.body.name !== undefined ? String(req.body.name).trim() : existing.name;
  const body = req.body.body !== undefined ? String(req.body.body) : existing.body;

  if (!name) {
    return res.status(400).json({ error: 'name must be non-empty' });
  }
  if (!body || !body.trim()) {
    return res.status(400).json({ error: 'body must be non-empty' });
  }

  db.prepare('UPDATE templates SET name = ?, body = ? WHERE id = ? AND user_id = ?').run(name, body, id, userId);
  const template = db.prepare('SELECT id, name, body FROM templates WHERE id = ?').get(id);
  return res.json(template);
});

// DELETE /api/templates/:id
router.delete('/templates/:id', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;

  const existing = db.prepare('SELECT id FROM templates WHERE id = ? AND user_id = ?').get(id, userId);
  if (!existing) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const inUse = db.prepare('SELECT id FROM schedules WHERE template_id = ? AND user_id = ?').get(id, userId);
  if (inUse) {
    return res.status(409).json({ error: 'Template in use by schedules' });
  }

  db.prepare('DELETE FROM templates WHERE id = ? AND user_id = ?').run(id, userId);
  return res.json({ ok: true });
});

// POST /api/templates/:id/preview
router.post('/templates/:id/preview', (req, res) => {
  const userId = req.session.userId;
  const { id } = req.params;
  const { contactId } = req.body || {};

  const template = db.prepare('SELECT id, name, body FROM templates WHERE id = ? AND user_id = ?').get(id, userId);
  if (!template) {
    return res.status(404).json({ error: 'Template not found' });
  }

  const contact = contactId
    ? db.prepare('SELECT name, phone FROM contacts WHERE id = ? AND user_id = ?').get(contactId, userId)
    : { name: 'Sample Friend', phone: '+910000000000' };

  if (contactId && !contact) {
    return res.status(404).json({ error: 'Contact not found' });
  }

  const rendered = render(template.body, contact);
  return res.json({ rendered });
});

module.exports = router;
