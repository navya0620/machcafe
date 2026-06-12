// routes/orders.js
const express = require('express');
const router  = express.Router();
const db      = require('../db');
const { verifyToken, ownerOnly, managerOrOwner, resolveBranch } = require('../middleware/auth');

// ── Helper: build full invoice with items + customer ──
function buildInvoiceResponse(inv) {
  const items    = db.prepare('SELECT * FROM order_items WHERE invoiceId = ?').all(inv.id);
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(inv.customerId);
  return { ...inv, items, customer };
}

// ── Helper: classify item as beverage or food ──
function classifyItem(name) {
  const n = name.toLowerCase();
  const beverageKeywords = ['coffee','latte','cappuccino','espresso','mocha','chai','matcha','brew','juice','smoothie','shake','soda','water','tea','frappe'];
  return beverageKeywords.some(k => n.includes(k)) ? 'beverage' : 'food';
}

// ── Helper: auto-refresh is_available based on stock ──
function refreshAvailability(branch_id) {
  const items = db.prepare('SELECT id FROM menu_items WHERE branch_id = ?').all(branch_id);
  for (const item of items) {
    const links = db.prepare(`
      SELECT i.currentQty, mii.qtyPerServing
      FROM menu_item_ingredients mii
      JOIN ingredients i ON mii.ingredientId = i.id
      WHERE mii.menuItemId = ?
    `).all(item.id);

    // If no recipe links mapped — leave as available (don't touch is_available)
    if (links.length === 0) continue;

    // Only mark OOS if recipe IS mapped and stock is insufficient
    const canMake = links.every(l => l.currentQty >= l.qtyPerServing);
    db.prepare('UPDATE menu_items SET is_available = ? WHERE id = ?')
      .run(canMake ? 1 : 0, item.id);
  }
}

// ═══════════════════════════════════════════════════════
//  POST /api/orders
//  Create a new order + invoice
//  Body: { branch_id, customerName, customerPhone, customerEmail,
//          customerAddress, tableNo, paymentMode, items[] }
// ═══════════════════════════════════════════════════════
router.post('/', verifyToken, resolveBranch, (req, res) => {
  const { customerName, customerPhone, customerEmail, customerAddress, tableNo, paymentMode, items } = req.body;
  if (!Array.isArray(items) || !items.length)
    return res.status(400).json({ success: false, error: 'items[] required' });

  try {
    const result = db.transaction(() => {
      // Upsert customer
      let customer;
      if (customerPhone)
        customer = db.prepare('SELECT * FROM customers WHERE phone = ?').get(customerPhone);

      if (!customer) {
        const insertName  = customerName  || 'Walk-in';
        const insertPhone = customerPhone || ('WALKIN-' + Date.now());
        const r = db.prepare(
          'INSERT INTO customers (name, phone, email, address) VALUES (?, ?, ?, ?)'
        ).run(insertName, insertPhone, customerEmail || null, customerAddress || null);
        customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(r.lastInsertRowid);
      }

      // Build invoice number — daily sequential (resets to 0001 each day)
      const _d  = new Date();
      const _yy = String(_d.getFullYear()).slice(-2);
      const _mm = String(_d.getMonth() + 1).padStart(2, '0');
      const _dd = String(_d.getDate()).padStart(2, '0');
      const datePrefix = `MACHB${req.branch_id}-${_yy}${_mm}${_dd}`;

      const todayCount = db.prepare(`
      SELECT COUNT(*) AS cnt FROM invoices
      WHERE branch_id = ? AND invoiceNo LIKE ?
      `).get(req.branch_id, datePrefix + '%').cnt;

      const seq = String(todayCount + 1).padStart(4, '0');
      const invoiceNo = `${datePrefix}-${seq}`;
      // GST — skip if branch has no GST OR cashier explicitly chose "without GST"
      // GST — purely based on cashier's choice, applies to ALL branches
      const subtotal = items.reduce((s, i) => s + i.qty * i.rate, 0);
      const withGst  = req.body.withGst !== false && req.body.withGst !== 'false';
      const noGst    = req.body.withGst === false || req.body.withGst === 'false' || req.body.withGst === 0;
      const cgst = noGst ? 0 : Math.round(subtotal * 0.025);
      const sgst = noGst ? 0 : Math.round(subtotal * 0.025);
      const grand = subtotal + cgst + sgst;
      // Capture IST timestamp at order placement time
      const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19);

      // To this:
      const inv = db.prepare(`
      INSERT INTO invoices (branch_id, invoiceNo, customerId, tableNo, paymentMode, subtotal, cgst, sgst, grand, timestamp, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'PAID')
      `).run(req.branch_id, invoiceNo, customer.id, tableNo || 'Counter', paymentMode || 'Cash', subtotal, cgst, sgst, grand, nowIST);    

      // Line items + deduct ingredients
      for (const item of items) {
        const amount = item.qty * item.rate;
        db.prepare(
          'INSERT INTO order_items (invoiceId, name, qty, rate, amount) VALUES (?, ?, ?, ?, ?)'
        ).run(inv.lastInsertRowid, item.name, item.qty, item.rate, amount);

        const menuItem = db.prepare('SELECT id FROM menu_items WHERE name = ? AND branch_id = ?').get(item.name, req.branch_id);
        if (menuItem) {
          const links = db.prepare('SELECT * FROM menu_item_ingredients WHERE menuItemId = ?').all(menuItem.id);
          for (const link of links) {
            const ing    = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(link.ingredientId);
            const newQty = Math.max(0, ing.currentQty - link.qtyPerServing * item.qty);
            db.prepare('UPDATE ingredients SET currentQty = ? WHERE id = ?').run(newQty, ing.id);
            db.prepare(`
              INSERT INTO inventory_logs (branch_id, itemId, logType, delta, newQty, note)
              VALUES (?, ?, 'order_deduction', ?, ?, ?)
            `).run(req.branch_id, ing.id, -(link.qtyPerServing * item.qty), newQty, `Order ${invoiceNo}`);
          }
        }
      }

      return { invoiceNo, grand, invoiceId: inv.lastInsertRowid };
    })();

    refreshAvailability(req.branch_id);

    const savedInv    = db.prepare('SELECT * FROM invoices WHERE invoiceNo = ?').get(result.invoiceNo);
    const fullInvoice = buildInvoiceResponse(savedInv);

    res.status(201).json({ success: true, invoiceNo: result.invoiceNo, grand: result.grand, invoice: fullInvoice });
  } catch (err) {
    console.error('Order error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  GET /api/orders/routing
//  Printer routing dashboard — branch scoped
// ═══════════════════════════════════════════════════════
router.get('/routing', verifyToken, resolveBranch, (req, res) => {
  try {
    const args = [req.branch_id];
    let q = `SELECT inv.*, c.name AS custName, c.phone AS custPhone
             FROM invoices inv
             JOIN customers c ON inv.customerId = c.id
             WHERE inv.branch_id = ?`;

    if (req.query.date) { q += ' AND inv.timestamp LIKE ?'; args.push(req.query.date + '%'); }
    q += ' ORDER BY inv.id DESC';

    const invoices = db.prepare(q).all(...args);
    const allDates = db.prepare(`
      SELECT DISTINCT substr(timestamp,1,10) AS d FROM invoices
      WHERE branch_id = ? ORDER BY d DESC
    `).all(req.branch_id).map(r => r.d);

    const orders = invoices.map(inv => {
      const items     = db.prepare('SELECT * FROM order_items WHERE invoiceId = ?').all(inv.id);
      const beverages = items.filter(i => classifyItem(i.name) === 'beverage');
      const food      = items.filter(i => classifyItem(i.name) === 'food');
      const printers  = [1];
      if (beverages.length) printers.push(2);
      if (food.length)      printers.push(3);
      return {
        invoiceNo:   inv.invoiceNo,
        timestamp:   inv.timestamp,
        tableNo:     inv.tableNo,
        status:      inv.status,
        grand:       inv.grand,
        paymentMode: inv.paymentMode,
        cgst:        inv.cgst,
        sgst:        inv.sgst,
        customer:    inv.custName,
        phone:       inv.custPhone,
        printers,
        breakdown: {
          beverages: beverages.map(i => ({ name: i.name, qty: i.qty, amount: i.amount })),
          food:      food.map(i => ({ name: i.name, qty: i.qty, amount: i.amount })),
          all:       items.map(i => ({ name: i.name, qty: i.qty, amount: i.amount })),
        },
      };
    });

    res.json({ success: true, orders, availableDates: allDates });
  } catch (err) {
    console.error('Routing error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});
router.get('/customers', verifyToken, managerOrOwner, (req, res) => {
  res.json({ success: true, customers: db.prepare('SELECT * FROM customers ORDER BY id DESC').all() });
});

router.get('/summary', verifyToken, resolveBranch, (req, res) => {
  const today     = new Date().toISOString().slice(0, 10);
  const todayInvs = db.prepare('SELECT * FROM invoices WHERE branch_id = ? AND timestamp LIKE ?').all(req.branch_id, today + '%');
  const allInvs   = db.prepare('SELECT * FROM invoices WHERE branch_id = ?').all(req.branch_id);
  const todayItems= todayInvs.flatMap(r => db.prepare('SELECT * FROM order_items WHERE invoiceId = ?').all(r.id));

  res.json({
    success: true,
    today: {
      date:      today,
      orders:    todayInvs.length,
      revenue:   todayInvs.reduce((s, i) => s + i.grand, 0),
      itemsSold: todayItems.reduce((s, i) => s + i.qty, 0),
    },
    allTime: {
      orders:    allInvs.length,
      revenue:   allInvs.reduce((s, i) => s + i.grand, 0),
      customers: db.prepare('SELECT COUNT(*) AS c FROM customers').get().c,
    },
  });
});

router.post('/park', verifyToken, resolveBranch, (req, res) => {
  const { token, tableNo, items, subtotal, gst, grand } = req.body;
  if (!token || !Array.isArray(items) || !items.length)
    return res.status(400).json({ success: false, error: 'token and items[] required' });

  try {
    const result = db.transaction(() => {
      const r = db.prepare(`
        INSERT INTO parked_orders (branch_id, token, tableNo, subtotal, gst, grand)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(req.branch_id, token, tableNo || 'Counter', subtotal || 0, gst || 0, grand || 0);

      const parkedId = r.lastInsertRowid;
      const addItem  = db.prepare(`
        INSERT INTO parked_order_items (parkedOrderId, name, emoji, qty, rate, amount)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const item of items)
        addItem.run(parkedId, item.name, item.emoji || '☕', item.qty, item.rate, item.amount);

      return parkedId;
    })();

    res.status(201).json({ success: true, id: result, token });
  } catch (err) {
    console.error('Park order error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════
//  PATCH /api/orders/:invoiceNo/status
//  Manager / Owner — update order status
// ═══════════════════════════════════════════════════════
/*router.patch('/:invoiceNo/status', verifyToken, managerOrOwner, (req, res) => {
  const { status } = req.body;
  if (!['PENDING','PREPARING','READY','DONE','CANCELLED'].includes(status))
    return res.status(400).json({ success: false, error: 'Invalid status' });

  const inv = db.prepare('SELECT id FROM invoices WHERE invoiceNo = ?').get(req.params.invoiceNo);
  if (!inv)
    return res.status(404).json({ success: false, error: 'Not found' });

  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, inv.id);
  res.json({ success: true });
});*/
router.get('/parked', verifyToken, resolveBranch, (req, res) => {
  try {
    const orders = db.prepare(`
      SELECT * FROM parked_orders
      WHERE branch_id = ? AND status = 'PARKED'
      ORDER BY id DESC
    `).all(req.branch_id);

    const result = orders.map(o => ({
      ...o,
      items: db.prepare('SELECT * FROM parked_order_items WHERE parkedOrderId = ?').all(o.id)
    }));

    res.json({ success: true, orders: result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});
router.get('/parked/:token', verifyToken, (req, res) => {
  const order = db.prepare('SELECT * FROM parked_orders WHERE token = ?').get(req.params.token);
  if (!order)
    return res.status(404).json({ success: false, error: 'Not found' });

  const items = db.prepare('SELECT * FROM parked_order_items WHERE parkedOrderId = ?').all(order.id);
  res.json({ success: true, order: { ...order, items } });
});
router.patch('/parked/:token/status', verifyToken, (req, res) => {
  const { status } = req.body;
  if (!['RESUMED', 'CANCELLED'].includes(status))
    return res.status(400).json({ success: false, error: 'status must be RESUMED or CANCELLED' });

  const order = db.prepare("SELECT id FROM parked_orders WHERE token = ? AND status = 'PARKED'").get(req.params.token);
  if (!order)
    return res.status(404).json({ success: false, error: 'Parked order not found or already resolved' });

  db.prepare('UPDATE parked_orders SET status = ? WHERE id = ?').run(status, order.id);
  res.json({ success: true });
});
router.patch('/:invoiceNo/status', verifyToken, managerOrOwner, (req, res) => {
  const { status } = req.body;
  if (!['PENDING','PREPARING','READY','DONE','CANCELLED'].includes(status))
    return res.status(400).json({ success: false, error: 'Invalid status' });

  const inv = db.prepare('SELECT id FROM invoices WHERE invoiceNo = ?').get(req.params.invoiceNo);
  if (!inv)
    return res.status(404).json({ success: false, error: 'Not found' });

  db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, inv.id);
  res.json({ success: true });
});
// ═══════════════════════════════════════════════════════
//  GET /api/orders/invoice/:invoiceNo
//  Single invoice with items + customer
// ═══════════════════════════════════════════════════════
router.get('/invoice/:invoiceNo', verifyToken, (req, res) => {
  const row = db.prepare('SELECT * FROM invoices WHERE invoiceNo = ?').get(req.params.invoiceNo);
  if (!row)
    return res.status(404).json({ success: false, error: 'Not found' });
  res.json({ success: true, invoice: buildInvoiceResponse(row) });
});

// ═══════════════════════════════════════════════════════
//  GET /api/orders/customers
//  All customers
// ═══════════════════════════════════════════════════════
/*router.get('/customers', verifyToken, managerOrOwner, (req, res) => {
  res.json({ success: true, customers: db.prepare('SELECT * FROM customers ORDER BY id DESC').all() });
});*/

// ═══════════════════════════════════════════════════════
//  GET /api/orders/customers/:phone
//  Customer by phone + their invoice history
// ═══════════════════════════════════════════════════════
router.get('/customers/:phone', verifyToken, managerOrOwner, (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE phone = ?').get(req.params.phone);
  if (!c)
    return res.status(404).json({ success: false, error: 'Not found' });

  const invs = db.prepare('SELECT * FROM invoices WHERE customerId = ? ORDER BY id DESC').all(c.id);
  res.json({ success: true, customer: c, invoices: invs.map(buildInvoiceResponse), totalOrders: invs.length });
});
module.exports = router;
