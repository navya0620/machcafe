// routes/branches.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { verifyToken, ownerOnly } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════
//  GET /api/branches
//  Public — used by owner-dashboard.html to load branch cards
// ═══════════════════════════════════════════════════════
router.get('/', (req, res) => {
  const branches = db.prepare(`
    SELECT * FROM branches ORDER BY id ASC
  `).all();
  res.json({ success: true, branches });
});

// ═══════════════════════════════════════════════════════
//  GET /api/branches/active
//  Public — only active branches (for login dropdowns etc.)
// ═══════════════════════════════════════════════════════
router.get('/active', (req, res) => {
  const branches = db.prepare(`
    SELECT * FROM branches WHERE is_active = 1 ORDER BY id ASC
  `).all();
  res.json({ success: true, branches });
});

// ═══════════════════════════════════════════════════════
//  GET /api/branches/:id
//  Public — single branch info (used by contact.html)
// ═══════════════════════════════════════════════════════
router.get('/:id', (req, res) => {
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!branch)
    return res.status(404).json({ success: false, error: 'Branch not found' });
  res.json({ success: true, branch });
});

// ═══════════════════════════════════════════════════════
//  POST /api/branches
//  Owner only — add a new branch
//  Body: { name, slug, location, phone, email, address, hours, seating, icon, color_class }
// ═══════════════════════════════════════════════════════
router.post('/', verifyToken, ownerOnly, (req, res) => {
  const { name, slug, location, phone, email, address, hours, seating, icon, color_class } = req.body;
  if (!name || !slug)
    return res.status(400).json({ success: false, error: 'name and slug are required' });

  try {
    const r = db.prepare(`
      INSERT INTO branches (name, slug, location, phone, email, address, hours, seating, icon, color_class, is_active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `).run(
      name, slug.toLowerCase().trim(),
      location || null, phone || null, email || null,
      address  || null, hours || '24/7',
      parseInt(seating) || 0,
      icon        || '🏘️',
      color_class || 'band-default'
    );
    res.status(201).json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    // Catches duplicate name or slug
    res.status(400).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  PUT /api/branches/:id
//  Owner only — edit a branch
// ═══════════════════════════════════════════════════════
router.put('/:id', verifyToken, ownerOnly, (req, res) => {
  const old = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!old)
    return res.status(404).json({ success: false, error: 'Branch not found' });

  const { name, slug, location, phone, email, address, hours, seating, icon, color_class } = req.body;

  try {
    db.prepare(`
      UPDATE branches SET
        name        = ?,
        slug        = ?,
        location    = ?,
        phone       = ?,
        email       = ?,
        address     = ?,
        hours       = ?,
        seating     = ?,
        icon        = ?,
        color_class = ?
      WHERE id = ?
    `).run(
      name        ?? old.name,
      slug        ? slug.toLowerCase().trim() : old.slug,
      location    ?? old.location,
      phone       ?? old.phone,
      email       ?? old.email,
      address     ?? old.address,
      hours       ?? old.hours,
      seating     != null ? parseInt(seating) : old.seating,
      icon        ?? old.icon,
      color_class ?? old.color_class,
      req.params.id
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  PATCH /api/branches/:id/toggle
//  Owner only — enable or disable a branch
// ═══════════════════════════════════════════════════════
router.patch('/:id/toggle', verifyToken, ownerOnly, (req, res) => {
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!branch)
    return res.status(404).json({ success: false, error: 'Branch not found' });

  const newStatus = branch.is_active ? 0 : 1;
  db.prepare('UPDATE branches SET is_active = ? WHERE id = ?').run(newStatus, req.params.id);
  res.json({ success: true, is_active: newStatus });
});

// ═══════════════════════════════════════════════════════
//  PATCH /api/branches/:id/gst
//  Owner only — enable or disable GST for a branch
// ═══════════════════════════════════════════════════════
router.patch('/:id/gst', verifyToken, ownerOnly, (req, res) => {
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!branch)
    return res.status(404).json({ success: false, error: 'Branch not found' });

  const { gst_enabled } = req.body;
  db.prepare('UPDATE branches SET gst_enabled = ? WHERE id = ?').run(gst_enabled ? 1 : 0, req.params.id);
  res.json({ success: true, gst_enabled: gst_enabled ? 1 : 0 });
});
// ═══════════════════════════════════════════════════════
//  DELETE /api/branches/:id
//  Owner only — permanently delete a branch
//  WARNING: cascades and deletes all inventory, menu, orders for that branch
// ═══════════════════════════════════════════════════════
router.delete('/:id', verifyToken, ownerOnly, (req, res) => {
  const branch = db.prepare('SELECT * FROM branches WHERE id = ?').get(req.params.id);
  if (!branch)
    return res.status(404).json({ success: false, error: 'Branch not found' });

  db.prepare('DELETE FROM branches WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;