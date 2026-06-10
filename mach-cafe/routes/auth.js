// routes/auth.js
const express  = require('express');
const router   = express.Router();
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');
const db       = require('../db');

const JWT_SECRET = process.env.JWT_SECRET || 'mach-cafe-secret-change-me';

// ═══════════════════════════════════════════════════════
//  POST /api/login
//  Body: { username, password }
//  Works for ALL roles: owner, manager, kitchen, staff
//  Returns: { success, token, user: { id, username, role, branch_id } }
// ═══════════════════════════════════════════════════════

router.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ success: false, error: 'username and password required' });

  const user = db.prepare('SELECT * FROM users WHERE username = ? AND is_active = 1').get(username);
  if (!user || !bcrypt.compareSync(password, user.password))
    return res.status(401).json({ success: false, error: 'Wrong username or password' });

  const token = jwt.sign(
    {
      id:        user.id,
      username:  user.username,
      role:      user.role,
      branch_id: user.branch_id ?? null,
    },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  // Fetch branch name if user has a branch
  let branch_name = null;
  let branch_slug = null;
  if (user.branch_id) {
    const branch = db.prepare('SELECT name, slug FROM branches WHERE id = ?').get(user.branch_id);
    branch_name = branch?.name || null;
    branch_slug = branch?.slug || null;
  }

  res.json({
    success: true,
    token,
    user: {
      id:          user.id,
      username:    user.username,
      role:        user.role,
      branch_id:   user.branch_id ?? null,
      branch_name: branch_name,
      branch_slug: branch_slug,
    }
  });
});

// ═══════════════════════════════════════════════════════
//  POST /api/owner/login   ← keeps your old HTML working
//  Body: { password }      (old owner-only login, no username)
//  Returns: { success, token }
// ═══════════════════════════════════════════════════════

router.post('/owner/login', (req, res) => {
  const { password } = req.body;
  if (!password)
    return res.status(400).json({ success: false, error: 'password required' });

  // Find the owner user in the DB
  const owner = db.prepare("SELECT * FROM users WHERE role = 'owner' AND is_active = 1 LIMIT 1").get();
  if (!owner || !bcrypt.compareSync(password, owner.password))
    return res.status(401).json({ success: false, error: 'Wrong password' });

  const token = jwt.sign(
    { id: owner.id, username: owner.username, role: 'owner', branch_id: null },
    JWT_SECRET,
    { expiresIn: '12h' }
  );

  res.json({ success: true, token });
});

// ═══════════════════════════════════════════════════════
//  GET /api/me
//  Returns current user info from token — useful for
//  HTML pages to know which branch they're logged into
// ═══════════════════════════════════════════════════════

const { verifyToken } = require('../middleware/auth');

router.get('/me', verifyToken, (req, res) => {
  const user = db.prepare('SELECT id, username, role, branch_id FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ success: false, error: 'User not found' });

  // If they have a branch, return the branch name too
  let branch = null;
  if (user.branch_id) {
    branch = db.prepare('SELECT id, name, slug FROM branches WHERE id = ?').get(user.branch_id);
  }

  res.json({ success: true, user, branch });
});

module.exports = router;