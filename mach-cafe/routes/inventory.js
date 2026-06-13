// routes/inventory.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { verifyToken, ownerOnly, managerOrOwner, resolveBranch } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════
//  GET /api/inventory
//  Kitchen + Manager + Owner
// ═══════════════════════════════════════════════════════
router.get('/', verifyToken, resolveBranch, (req, res) => {
  const items = db.prepare(`
    SELECT * FROM ingredients
    WHERE branch_id = ?
    ORDER BY category, name
  `).all(req.branch_id);
  res.json({ success: true, items });
});

// ═══════════════════════════════════════════════════════
//  GET /api/inventory/logs
//  Manager + Owner
// ═══════════════════════════════════════════════════════
router.get('/logs', verifyToken, resolveBranch, (req, res) => {
  let q    = `SELECT l.*, i.name AS itemName
               FROM inventory_logs l
               LEFT JOIN ingredients i ON l.itemId = i.id
               WHERE l.branch_id = ?`;
  const args = [req.branch_id];

  if (req.query.date) {
    q += ' AND l.createdAt LIKE ?';
    args.push(req.query.date + '%');
  }

  q += ' ORDER BY l.id DESC LIMIT 500';
  res.json({ success: true, logs: db.prepare(q).all(...args) });
});

// ═══════════════════════════════════════════════════════
//  GET /api/inventory/:id
//  Manager + Owner — single ingredient
// ═══════════════════════════════════════════════════════
router.get('/:id', verifyToken, (req, res) => {
  const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(req.params.id);
  if (!ing)
    return res.status(404).json({ success: false, error: 'Not found' });

  const usedIn = db.prepare(`
    SELECT m.name AS menuItem, mii.qtyPerServing
    FROM menu_item_ingredients mii
    JOIN menu_items m ON mii.menuItemId = m.id
    WHERE mii.ingredientId = ?
  `).all(req.params.id);

  res.json({ success: true, ingredient: ing, usedIn });
});

// ═══════════════════════════════════════════════════════
//  POST /api/inventory
//  Manager + Owner — add a new ingredient
// ═══════════════════════════════════════════════════════
router.post('/', verifyToken, resolveBranch, (req, res) => {
  const { name, unit, currentQty, reorderLevel, category } = req.body;
  if (!name || !unit)
    return res.status(400).json({ success: false, error: 'name and unit required' });

  const qty = parseFloat(currentQty) || 0;

  try {
    const r = db.prepare(`
      INSERT INTO ingredients (branch_id, name, unit, currentQty, reorderLevel, category)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.branch_id, name, unit, qty,
      parseFloat(reorderLevel) || 0,
      category || 'Other'
    );

    if (qty > 0) {
      db.prepare(`
        INSERT INTO inventory_logs (branch_id, itemId, logType, delta, newQty, note)
        VALUES (?, ?, 'manual', ?, ?, 'Initial stock')
      `).run(req.branch_id, r.lastInsertRowid, qty, qty);
    }

    res.status(201).json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  PUT /api/inventory/:id
//  Manager + Owner — update an ingredient
// ═══════════════════════════════════════════════════════
router.put('/:id', verifyToken, (req, res) => {
  const old = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(req.params.id);
  if (!old)
    return res.status(404).json({ success: false, error: 'Not found' });

  const { name, unit, currentQty, reorderLevel, category } = req.body;
  const newQty = parseFloat(currentQty);

  db.prepare(`
    UPDATE ingredients SET name=?, unit=?, currentQty=?, reorderLevel=?, category=?
    WHERE id=?
  `).run(
    name        ?? old.name,
    unit        ?? old.unit,
    newQty,
    parseFloat(reorderLevel) ?? old.reorderLevel,
    category    ?? old.category,
    req.params.id
  );

  if (newQty !== old.currentQty) {
    db.prepare(`
      INSERT INTO inventory_logs (branch_id, itemId, logType, delta, newQty, note)
      VALUES (?, ?, 'manual', ?, ?, 'Manual update')
    `).run(old.branch_id, req.params.id, newQty - old.currentQty, newQty);
  }

  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
//  POST /api/inventory/stock-entry
//  Kitchen + Manager + Owner — bulk daily stock update
// ═══════════════════════════════════════════════════════
router.post('/stock-entry', verifyToken, resolveBranch, (req, res) => {
  const { entries } = req.body;
  if (!Array.isArray(entries))
    return res.status(400).json({ success: false, error: 'entries[] required' });

  db.transaction(() => {
    for (const e of entries) {
      const old = db.prepare('SELECT * FROM ingredients WHERE id = ? AND branch_id = ?').get(e.id, req.branch_id);
      if (!old) continue;
      const newQty = parseFloat(e.qty) || 0;
      db.prepare('UPDATE ingredients SET currentQty = ? WHERE id = ?').run(newQty, e.id);
      db.prepare(`
        INSERT INTO inventory_logs (branch_id, itemId, logType, delta, newQty, note)
        VALUES (?, ?, 'restock', ?, ?, 'Daily stock entry')
      `).run(req.branch_id, e.id, newQty - old.currentQty, newQty);
    }
  })();

  res.json({ success: true, updated: entries.length });
});

// ═══════════════════════════════════════════════════════
//  POST /api/inventory/import
//  Kitchen + Manager + Owner — import from Excel
// ═══════════════════════════════════════════════════════
router.post('/import', verifyToken, resolveBranch, (req, res) => {
  const { rows, clearFirst } = req.body;
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ success: false, error: 'rows[] required' });

  try {
    let inserted = 0, updated = 0;
    const errors = [];

    db.transaction(() => {
      if (clearFirst) {
        const ids = db.prepare('SELECT id FROM ingredients WHERE branch_id = ?').all(req.branch_id).map(r => r.id);
        if (ids.length) {
          const ph = ids.map(() => '?').join(',');
          db.prepare(`DELETE FROM menu_item_ingredients WHERE ingredientId IN (${ph})`).run(...ids);
          db.prepare(`DELETE FROM inventory_logs WHERE itemId IN (${ph})`).run(...ids);
        }
        db.prepare('DELETE FROM ingredients WHERE branch_id = ?').run(req.branch_id);
      }

      const upsert = db.prepare(`
        INSERT INTO ingredients (branch_id, name, unit, currentQty, reorderLevel, category)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(branch_id, name) DO UPDATE SET
          unit         = excluded.unit,
          currentQty   = excluded.currentQty,
          reorderLevel = excluded.reorderLevel,
          category     = excluded.category
      `);

      for (const [idx, r] of rows.entries()) {
        const name = (r.name || '').toString().trim();
        if (!name) { errors.push(`Row ${idx + 1}: missing name`); continue; }

        const info = upsert.run(
          req.branch_id,
          name,
          (r.unit     || 'units').toString().trim(),
          parseFloat(r.currentQty)   || 0,
          parseFloat(r.reorderLevel) || 0,
          (r.category || 'Other').toString().trim()
        );

        if (info.lastInsertRowid > 0 && info.changes === 1) inserted++;
        else updated++;
      }
    })();

    res.json({ success: true, inserted, updated, errors });
  } catch (err) {
    console.error('Import error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  DELETE /api/inventory/:id
//  Manager + Owner only
// ═══════════════════════════════════════════════════════
router.delete('/:id', verifyToken, managerOrOwner, (req, res) => {
  if (!db.prepare('SELECT id FROM ingredients WHERE id = ?').get(req.params.id))
    return res.status(404).json({ success: false, error: 'Not found' });

  db.prepare('DELETE FROM ingredients WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;