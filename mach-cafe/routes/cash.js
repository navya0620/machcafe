// routes/cash.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { verifyToken, resolveBranch } = require('../middleware/auth');

// ── Helper: today's date in IST (YYYY-MM-DD) ──
function todayIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);
}

// ── Helper: IST datetime string ──
function nowIST() {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000)
    .toISOString().replace('T', ' ').slice(0, 19);
}

// ═══════════════════════════════════════════════════════
//  GET /api/cash/today
//  Returns today's cash register entry for the branch
// ═══════════════════════════════════════════════════════
router.get('/today', verifyToken, resolveBranch, (req, res) => {
  try {
    const reqDate = req.query.date || todayIST();
    const row = db.prepare(`SELECT * FROM cash_register WHERE branch_id = ? AND date = ?`).get(req.branch_id, reqDate);
    res.json({ 
  success: true, date: reqDate,  
  opening_cash:    row?.opening_cash    ?? null,
  closing_cash:    row?.closing_cash    ?? null,
  given_to_owner:  row?.given_to_owner  ?? null,
  opened_at:       row?.opened_at       ?? null,
  closed_at:       row?.closed_at       ?? null,
  given_at:        row?.given_at        ?? null,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  POST /api/cash/open
//  Set or update opening cash for today
// ═══════════════════════════════════════════════════════
router.post('/open', verifyToken, resolveBranch, (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount < 0)
    return res.status(400).json({ success: false, error: 'Invalid amount' });

  try {
    const payload  = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64').toString());
    const userId   = payload.id || null;

    db.prepare(`
      INSERT INTO cash_register (branch_id, date, opening_cash, opened_by, opened_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(branch_id, date) DO UPDATE SET
        opening_cash = excluded.opening_cash,
        opened_by    = excluded.opened_by,
        opened_at    = excluded.opened_at
    `).run(req.branch_id, todayIST(), amount, userId, nowIST());

    res.json({ success: true, opening_cash: amount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  POST /api/cash/close
//  Set or update closing cash for today
// ═══════════════════════════════════════════════════════
router.post('/close', verifyToken, resolveBranch, (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount < 0)
    return res.status(400).json({ success: false, error: 'Invalid amount' });

  try {
    const payload = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64').toString());
    const userId  = payload.id || null;

    // Must have opening cash set first
    const row = db.prepare(`
      SELECT opening_cash FROM cash_register
      WHERE branch_id = ? AND date = ?
    `).get(req.branch_id, todayIST());

    if (!row || row.opening_cash === null)
      return res.status(400).json({ success: false, error: 'Opening cash not set for today' });

    db.prepare(`
      UPDATE cash_register
      SET closing_cash = ?, closed_by = ?, closed_at = ?
      WHERE branch_id = ? AND date = ?
    `).run(amount, userId, nowIST(), req.branch_id, todayIST());

    res.json({ success: true, closing_cash: amount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  GET /api/cash/history
//  Last 30 days of cash register entries (owner/manager)
// ═══════════════════════════════════════════════════════
router.get('/history', verifyToken, resolveBranch, (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT cr.*, 
             u1.username AS opened_by_name,
             u2.username AS closed_by_name
      FROM cash_register cr
      LEFT JOIN users u1 ON cr.opened_by = u1.id
      LEFT JOIN users u2 ON cr.closed_by = u2.id
      WHERE cr.branch_id = ?
      ORDER BY cr.date DESC
      LIMIT 30
    `).all(req.branch_id);

    res.json({ success: true, history: rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
// ═══════════════════════════════════════════════════════
//  POST /api/cash/given
//  Set or update the amount given by cashier to owner
// ═══════════════════════════════════════════════════════
router.post('/given', verifyToken, resolveBranch, (req, res) => {
  const amount = parseFloat(req.body.amount);
  if (isNaN(amount) || amount < 0)
    return res.status(400).json({ success: false, error: 'Invalid amount' });

  try {
    const payload = JSON.parse(Buffer.from(req.headers.authorization.split('.')[1], 'base64').toString());
    const userId  = payload.id || null;

    const row = db.prepare(`
      SELECT opening_cash FROM cash_register
      WHERE branch_id = ? AND date = ?
    `).get(req.branch_id, todayIST());

    if (!row || row.opening_cash === null)
      return res.status(400).json({ success: false, error: 'Opening cash not set for today' });

    db.prepare(`
      UPDATE cash_register
      SET given_to_owner = ?, given_by = ?, given_at = ?
      WHERE branch_id = ? AND date = ?
    `).run(amount, userId, nowIST(), req.branch_id, todayIST());

    res.json({ success: true, given_to_owner: amount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
module.exports = router;