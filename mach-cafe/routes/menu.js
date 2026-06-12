// routes/menu.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { verifyToken, ownerOnly, resolveBranch } = require('../middleware/auth');

// ═══════════════════════════════════════════════════════
//  GET /api/menu
//  Public — get full menu for a branch
//  Pass ?branch_id=1
// ═══════════════════════════════════════════════════════
router.get('/', (req, res) => {
  const branch_id = parseInt(req.query.branch_id);
  if (!branch_id)
    return res.status(400).json({ success: false, error: 'branch_id required' });

  const items = db.prepare(`
    SELECT * FROM menu_items
    WHERE branch_id = ?
    ORDER BY section, name
  `).all(branch_id);

  res.json({ success: true, items });
});
router.get('/sections', (req, res) => {
  const branch_id = parseInt(req.query.branch_id);
  if (!branch_id)
    return res.status(400).json({ success: false, error: 'branch_id required' });

  const sections = db.prepare(`
    SELECT * FROM menu_sections
    WHERE branch_id = ? AND is_active = 1
    ORDER BY sort_order, id
  `).all(branch_id);

  res.json({ success: true, sections });
});

// ═══════════════════════════════════════════════════════
//  POST /api/menu/sections — add a section
// ═══════════════════════════════════════════════════════
router.post('/sections', verifyToken, resolveBranch, (req, res) => {
  const { slug, icon, title, description, sort_order } = req.body;
  if (!slug || !title)
    return res.status(400).json({ success: false, error: 'slug and title required' });

  try {
    const r = db.prepare(`
      INSERT INTO menu_sections (branch_id, slug, icon, title, description, sort_order)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      req.branch_id,
      slug.toLowerCase().trim().replace(/\s+/g, '-'),
      icon || '🍽️',
      title,
      description || '',
      parseInt(sort_order) || 0
    );
    res.status(201).json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ success: false, error: 'Section slug already exists' });
  }
});

// ═══════════════════════════════════════════════════════
//  PUT /api/menu/sections/:id — edit a section
// ═══════════════════════════════════════════════════════
router.put('/sections/:id', verifyToken, resolveBranch, (req, res) => {
  const { icon, title, description, sort_order } = req.body;
  const old = db.prepare('SELECT * FROM menu_sections WHERE id = ?').get(req.params.id);
  if (!old) return res.status(404).json({ success: false, error: 'Not found' });

  db.prepare(`
    UPDATE menu_sections SET icon=?, title=?, description=?, sort_order=? WHERE id=?
  `).run(
    icon        ?? old.icon,
    title       ?? old.title,
    description ?? old.description,
    sort_order  != null ? parseInt(sort_order) : old.sort_order,
    req.params.id
  );
  res.json({ success: true });
});
router.delete('/sections/:id', verifyToken, (req, res) => {
  db.prepare('DELETE FROM menu_sections WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});
// ═══════════════════════════════════════════════════════
router.post('/import-excel', verifyToken, resolveBranch, (req, res) => {
  const { rows } = req.body;
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ success: false, error: 'rows[] required' });

  function parseBool(v, def) {
    if (v === undefined || v === null || v === '') return def;
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number')  return v !== 0;
    const s = String(v).trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'yes';
  }

  const errors   = [];
  const inserted = [];
  /*const validSections = new Set([
  'coffees','cold','shakes','food','snacks','desserts',
  'icecreams','biscuits','biryani','cold-mojitos',
  'shakes-falooda','meals','drinks','starters','soups'
  ]);*/
  const seenNames = new Set();

  db.transaction(() => {
    // Clear existing menu for this branch before fresh import
    db.prepare('DELETE FROM menu_items WHERE branch_id = ?').run(req.branch_id);

    for (const [idx, row] of rows.entries()) {
      let name  = (row['Item Name'] || row.name  || row.Name  || '').toString().trim();
      const rawPrice = row['Price (INR)'] || row.price || row.Price || 0;
      const price    = parseInt(rawPrice, 10);
      const section  = (row['Section'] || row.section || '').toString().trim().toLowerCase();
      const desc     = (row['Description'] || row.description || '').toString().trim() || null;
      const emoji    = (row['Emoji'] || row.emoji || '☕').toString().trim() || '☕';
      const rawBadge = (row['Badge'] || row.badge || '').toString().trim();
      const badge    = rawBadge ? rawBadge.replace('premiujm', 'premium') : null;
      const category = (row['Category'] || row.category || 'beverage').toString().trim().toLowerCase();
      const isFeatured  = parseBool(row['Featured']  || row.isFeatured,  false) ? 1 : 0;
      const is_available = parseBool(row['Available'] || row.isAvailable, true)  ? 1 : 0;
      // Skip instruction row
      if (name === 'Item Name (required)' || name === 'Item Name') continue;
      if (!name)  { errors.push(`Row ${idx + 2}: missing name`);  continue; }
      if (!price) { errors.push(`Row ${idx + 2}: skipped "${name}" — no price`); continue; }
      if (!section) {
        errors.push(`Row ${idx + 2} "${name}": missing section`);
        continue;
      }

      // Handle duplicate names
      let uniqueName = name;
      if (seenNames.has(name.toLowerCase()))
        uniqueName = desc ? `${name} (${desc})` : `${name} (${section})`;

      let attempt = uniqueName;
      let counter = 2;
      while (seenNames.has(attempt.toLowerCase()))
        attempt = `${uniqueName} ${counter++}`;

      uniqueName = attempt;
      seenNames.add(uniqueName.toLowerCase());

      db.prepare(`
        INSERT INTO menu_items (branch_id, name, price, emoji, section, category, badge, description, isFeatured, is_available)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.branch_id, uniqueName, price, emoji, section, category, badge, desc, isFeatured, is_available);

      inserted.push(uniqueName);
    }
  })();

  res.json({ success: true, inserted: inserted.length, errors });
});

// ═══════════════════════════════════════════════════════
//  GET /api/menu/recipes/all
//  Owner — get all recipes (menu items + their ingredients)
// ═══════════════════════════════════════════════════════
router.get('/recipes/all', verifyToken, resolveBranch, (req, res) => {
  const menuItems = db.prepare(`
    SELECT id, name, section, category FROM menu_items
    WHERE branch_id = ?
    ORDER BY section, name
  `).all(req.branch_id);

  const result = menuItems.map(item => {
    const links = db.prepare(`
      SELECT mii.id AS linkId, mii.ingredientId, mii.qtyPerServing,
             i.name AS ingredientName, i.unit, i.currentQty
      FROM menu_item_ingredients mii
      JOIN ingredients i ON mii.ingredientId = i.id
      WHERE mii.menuItemId = ?
      ORDER BY i.name
    `).all(item.id);
    return { ...item, ingredients: links };
  });

  res.json({ success: true, recipes: result });
});

// ═══════════════════════════════════════════════════════
//  GET /api/menu/:menuItemId/recipe
//  Single item recipe
// ═══════════════════════════════════════════════════════
router.get('/:menuItemId/recipe', verifyToken, (req, res) => {
  const item = db.prepare('SELECT id, name, section FROM menu_items WHERE id = ?').get(req.params.menuItemId);
  if (!item)
    return res.status(404).json({ success: false, error: 'Menu item not found' });

  const links = db.prepare(`
    SELECT mii.id AS linkId, mii.ingredientId, mii.qtyPerServing,
           i.name AS ingredientName, i.unit, i.currentQty
    FROM menu_item_ingredients mii
    JOIN ingredients i ON mii.ingredientId = i.id
    WHERE mii.menuItemId = ?
    ORDER BY i.name
  `).all(item.id);

  res.json({ success: true, recipe: { ...item, ingredients: links } });
});

// ═══════════════════════════════════════════════════════
//  POST /api/menu/:menuItemId/recipe
//  Owner — link an ingredient to a menu item
//  Body: { ingredientId, qtyPerServing }
// ═══════════════════════════════════════════════════════
router.post('/:menuItemId/recipe', verifyToken, ownerOnly, (req, res) => {
  const { ingredientId, qtyPerServing } = req.body;
  if (!ingredientId || !qtyPerServing)
    return res.status(400).json({ success: false, error: 'ingredientId and qtyPerServing required' });

  if (!db.prepare('SELECT id FROM menu_items WHERE id = ?').get(req.params.menuItemId))
    return res.status(404).json({ success: false, error: 'Menu item not found' });

  if (!db.prepare('SELECT id FROM ingredients WHERE id = ?').get(ingredientId))
    return res.status(404).json({ success: false, error: 'Ingredient not found' });

  try {
    const r = db.prepare(`
      INSERT INTO menu_item_ingredients (menuItemId, ingredientId, qtyPerServing)
      VALUES (?, ?, ?)
      ON CONFLICT(menuItemId, ingredientId) DO UPDATE SET qtyPerServing = excluded.qtyPerServing
    `).run(req.params.menuItemId, ingredientId, parseFloat(qtyPerServing));

    res.status(201).json({ success: true, linkId: r.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  DELETE /api/menu/:menuItemId/recipe
//  Owner — clear all ingredients from a recipe
// ═══════════════════════════════════════════════════════
router.delete('/:menuItemId/recipe', verifyToken, ownerOnly, (req, res) => {
  db.prepare('DELETE FROM menu_item_ingredients WHERE menuItemId = ?').run(req.params.menuItemId);
  res.json({ success: true });
});
// ── PUT /api/menu/recipe-link/:linkId — edit qty per serving ──
router.put('/recipe-link/:linkId', verifyToken, ownerOnly, (req, res) => {
  const { qtyPerServing } = req.body;
  if (!qtyPerServing || qtyPerServing <= 0)
    return res.status(400).json({ success: false, error: 'qtyPerServing required' });

  const link = db.prepare('SELECT id FROM menu_item_ingredients WHERE id = ?').get(req.params.linkId);
  if (!link)
    return res.status(404).json({ success: false, error: 'Link not found' });

  db.prepare('UPDATE menu_item_ingredients SET qtyPerServing = ? WHERE id = ?')
    .run(parseFloat(qtyPerServing), req.params.linkId);

  res.json({ success: true });
});

// ── DELETE /api/menu/recipe-link/:linkId — remove one ingredient from recipe ──
router.delete('/recipe-link/:linkId', verifyToken, ownerOnly, (req, res) => {
  const link = db.prepare('SELECT id FROM menu_item_ingredients WHERE id = ?').get(req.params.linkId);
  if (!link)
    return res.status(404).json({ success: false, error: 'Link not found' });

  db.prepare('DELETE FROM menu_item_ingredients WHERE id = ?').run(req.params.linkId);
  res.json({ success: true });
});
router.post('/recipes/import', verifyToken, resolveBranch, (req, res) => {
  const { rows, clearFirst } = req.body;
  if (!Array.isArray(rows) || !rows.length)
    return res.status(400).json({ success: false, error: 'rows[] required' });

  try {
    const errors  = [];
    const skipped = [];
    let   linked  = 0;

    db.transaction(() => {
      if (clearFirst) {
        db.prepare('DELETE FROM menu_item_ingredients').run();
      }

      for (const [idx, row] of rows.entries()) {
        const menuItemName   = (row.menuItem   || row['Menu Item']  || '').toString().trim();
        const ingredientName = (row.ingredient || row['Ingredient'] || '').toString().trim().toLowerCase();
        const qty            = parseFloat(row.qtyPerServing || row['Qty Per Serving'] || 0);

        if (!menuItemName)    { errors.push(`Row ${idx+1}: missing Menu Item`);  continue; }
        if (!ingredientName)  { errors.push(`Row ${idx+1}: missing Ingredient`); continue; }
        if (!qty || qty <= 0) { errors.push(`Row ${idx+1}: qty must be > 0`);    continue; }

        const menuItem = db.prepare(
          'SELECT id FROM menu_items WHERE LOWER(name) = LOWER(?) AND branch_id = ?'
        ).get(menuItemName, req.branch_id);

        if (!menuItem) {
          skipped.push(`"${menuItemName}" — not found in menu for this branch`);
          continue;
        }

        const ingredient = db.prepare(
          'SELECT id FROM ingredients WHERE LOWER(name) = LOWER(?) AND branch_id = ?'
        ).get(ingredientName, req.branch_id);

        if (!ingredient) {
          skipped.push(`"${ingredientName}" — not found in ingredients for this branch`);
          continue;
        }

        db.prepare(`
          INSERT INTO menu_item_ingredients (menuItemId, ingredientId, qtyPerServing)
          VALUES (?, ?, ?)
          ON CONFLICT(menuItemId, ingredientId) DO UPDATE SET qtyPerServing = excluded.qtyPerServing
        `).run(menuItem.id, ingredient.id, qty);

        linked++;
      }
    })();

    res.json({ success: true, linked, skipped: skipped.length, errors, skippedItems: skipped });
  } catch (err) {
    console.error('Recipe import error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// ═══════════════════════════════════════════════════════
//  GET /api/menu/:id
//  Public — single menu item
// ═══════════════════════════════════════════════════════
router.get('/:id', (req, res) => {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!item)
    return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, item });
});

// ═══════════════════════════════════════════════════════
//  POST /api/menu
//  Owner only — add a menu item to a branch
//  Body: { branch_id, name, price, emoji, section, category, badge, description, isFeatured }
// ═══════════════════════════════════════════════════════
router.post('/', verifyToken, ownerOnly, resolveBranch, (req, res) => {
  const { name, price, emoji, section, category, badge, description, isFeatured } = req.body;
  if (!name || !price || !section)
    return res.status(400).json({ success: false, error: 'name, price, section required' });

  const r = db.prepare(`
    INSERT INTO menu_items (branch_id, name, price, emoji, section, category, badge, description, isFeatured)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.branch_id, name, price,
    emoji       || '☕',
    section,
    category    || 'beverage',
    badge       || null,
    description || null,
    isFeatured  ? 1 : 0
  );

  res.status(201).json({ success: true, id: r.lastInsertRowid });
});
router.put('/:id', verifyToken, ownerOnly, (req, res) => {
  const old = db.prepare('SELECT * FROM menu_items WHERE id = ?').get(req.params.id);
  if (!old)
    return res.status(404).json({ success: false, error: 'Not found' });

  const { name, price, emoji, section, category, badge, description, isFeatured, is_available } = req.body;

  db.prepare(`
    UPDATE menu_items SET
      name=?, price=?, emoji=?, section=?, category=?,
      badge=?, description=?, isFeatured=?, is_available=?
    WHERE id=?
  `).run(
    name         ?? old.name,
    price        ?? old.price,
    emoji        ?? old.emoji,
    section      ?? old.section,
    category     ?? old.category,
    badge        ?? old.badge,
    description  ?? old.description,
    isFeatured   != null ? (isFeatured  ? 1 : 0) : old.isFeatured,
    is_available != null ? (is_available ? 1 : 0) : old.is_available,
    req.params.id
  );

  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════
//  DELETE /api/menu/:id
//  Owner only — delete a menu item
// ═══════════════════════════════════════════════════════
router.delete('/:id', verifyToken, ownerOnly, (req, res) => {
  if (!db.prepare('SELECT id FROM menu_items WHERE id = ?').get(req.params.id))
    return res.status(404).json({ success: false, error: 'Not found' });

  db.prepare('DELETE FROM menu_items WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});
module.exports = router;