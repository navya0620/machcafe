// routes/users.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const bcrypt  = require('bcryptjs');
const { verifyToken, ownerOnly } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════
//  GET /api/users
//  Owner only — list all staff users
// ═══════════════════════════════════════════════════════
router.get('/', verifyToken, ownerOnly, (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.username, u.role, u.is_active, u.created_at,
           b.name AS branch_name, b.id AS branch_id
    FROM users u
    LEFT JOIN branches b ON u.branch_id = b.id
    ORDER BY u.id ASC
  `).all();
  res.json({ success: true, users });
});

// ═══════════════════════════════════════════════════════
//  POST /api/users
//  Owner only — create a new staff user
//  Body: { username, password, role, branch_id }
//  Roles: owner | manager | kitchen | staff
// ═══════════════════════════════════════════════════════
router.post('/', verifyToken, ownerOnly, (req, res) => {
  const { username, password, role, branch_id } = req.body;

  if (!username || !password || !role)
    return res.status(400).json({ success: false, error: 'username, password and role required' });

  const validRoles = ['owner', 'manager', 'staff', 'cashier'];
  if (!validRoles.includes(role))
    return res.status(400).json({ success: false, error: `role must be one of: ${validRoles.join(', ')}` });

  // Non-owner roles must have a branch
  if (role !== 'owner' && !branch_id)
    return res.status(400).json({ success: false, error: 'branch_id is required for non-owner roles' });

  // Check branch exists
  if (branch_id) {
    const branch = db.prepare('SELECT id FROM branches WHERE id = ?').get(branch_id);
    if (!branch)
      return res.status(404).json({ success: false, error: 'Branch not found' });
  }

  try {
    const hash = bcrypt.hashSync(password, 10);
    const r    = db.prepare(`
      INSERT INTO users (username, password, role, branch_id, is_active)
      VALUES (?, ?, ?, ?, 1)
    `).run(username, hash, role, branch_id || null);

    res.status(201).json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    // Catches duplicate username
    res.status(400).json({ success: false, error: 'Username already exists' });
  }
});

// ═══════════════════════════════════════════════════════
//  PUT /api/users/:id
//  Owner only — update a user's role, branch or password
//  Body: { role?, branch_id?, password? }
// ═══════════════════════════════════════════════════════
router.put('/:id', verifyToken, ownerOnly, (req, res) => {
  const old = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!old)
    return res.status(404).json({ success: false, error: 'User not found' });

  const { role, branch_id, password, username } = req.body;

  // Validate role if provided
  if (role) {
    const validRoles = ['owner', 'manager', 'kitchen', 'staff'];
    if (!validRoles.includes(role))
      return res.status(400).json({ success: false, error: `role must be one of: ${validRoles.join(', ')}` });
  }

  // Hash new password if provided
  const newHash = password ? bcrypt.hashSync(password, 10) : old.password;

  try {
    const newIsActive = req.body.is_active != null ? req.body.is_active : old.is_active;
    db.prepare(`
      UPDATE users SET username=?, password=?, role=?, branch_id=?, is_active=?
      WHERE id=?
    `).run(
      username  ?? old.username,
      newHash,
      role      ?? old.role,
      branch_id != null ? branch_id : old.branch_id,
      newIsActive,
      req.params.id
    );
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  PATCH /api/users/:id/toggle
//  Owner only — enable or disable a user account
// ═══════════════════════════════════════════════════════
router.patch('/:id/toggle', verifyToken, ownerOnly, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user)
    return res.status(404).json({ success: false, error: 'User not found' });

  const newStatus = user.is_active ? 0 : 1;
  db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newStatus, req.params.id);
  res.json({ success: true, is_active: newStatus });
});

// ═══════════════════════════════════════════════════════
//  DELETE /api/users/:id
//  Owner only — permanently delete a user
// ═══════════════════════════════════════════════════════
router.delete('/:id', verifyToken, ownerOnly, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user)
    return res.status(404).json({ success: false, error: 'User not found' });

  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;