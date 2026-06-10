/**
 * MACH Cafe — server.js
 * Stack: Node.js · Express · better-sqlite3 · JWT
 *
 * npm install express cors better-sqlite3 jsonwebtoken bcryptjs
 * node server.js
 */

const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const jwt      = require('jsonwebtoken');
const bcrypt   = require('bcryptjs');

const app  = express();
const PORT = 3000;

// ── Middleware ──────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── SheetJS — serve locally so HTML pages don't need CDN ──
app.get('/xlsx.full.min.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js'));
});

// ── Routes ──────────────────────────────────────────────
const authRoutes      = require('./routes/auth');
const branchRoutes    = require('./routes/branches');
const inventoryRoutes = require('./routes/inventory');
const menuRoutes      = require('./routes/menu');
const orderRoutes     = require('./routes/orders');
const userRoutes      = require('./routes/users');

app.use('/api',            authRoutes);
app.use('/api/branches',   branchRoutes);
app.use('/api/inventory',  inventoryRoutes);
app.use('/api/menu',       menuRoutes);
app.use('/api/orders',     orderRoutes);
app.use('/api/users',      userRoutes);

// ═══════════════════════════════════════════════════════
//  THERMAL PRINTER — ESC/POS DIRECT PRINT
// ═══════════════════════════════════════════════════════

// ▼▼▼ EDIT THESE TWO LINES ▼▼▼
const THERMAL_PRINTER_INTERFACE = 'tcp://192.168.1.87:9100'; // ← your printer IP:port
const THERMAL_PRINTER_WIDTH_MM  = 80;                         // ← 58 or 80
// ▲▲▲ EDIT THESE TWO LINES ▲▲▲

let ThermalPrinter, PrinterTypes;
try {
  const ntp    = require('node-thermal-printer');
  ThermalPrinter = ntp.printer;
  PrinterTypes   = ntp.types;
} catch (e) {
  console.warn('⚠️  node-thermal-printer not installed. Direct ESC/POS printing disabled.');
  console.warn('   Run: npm install node-thermal-printer  to enable it.');
}

const db = require('./db');

/* POST /api/print
   Body: { invoiceNo }
   Fetches invoice from DB and sends to thermal printer. */
app.post('/api/print', async (req, res) => {
  if (!ThermalPrinter)
    return res.status(503).json({ success: false, error: 'node-thermal-printer not installed.' });

  const { invoiceNo } = req.body;
  if (!invoiceNo)
    return res.status(400).json({ success: false, error: 'invoiceNo required' });

  const inv = db.prepare('SELECT * FROM invoices WHERE invoiceNo = ?').get(invoiceNo);
  if (!inv)
    return res.status(404).json({ success: false, error: 'Invoice not found' });

  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(inv.customerId);
  const items    = db.prepare('SELECT * FROM order_items WHERE invoiceId = ?').all(inv.id);
  const branch   = db.prepare('SELECT * FROM branches WHERE id = ?').get(inv.branch_id);

  const lineWidth = THERMAL_PRINTER_WIDTH_MM >= 80 ? 48 : 32;
  const colNameW  = THERMAL_PRINTER_WIDTH_MM >= 80 ? 28 : 18;
  const colQtyW   = 4;
  const colAmtW   = lineWidth - colNameW - colQtyW;

  function pad(str, len, right = false) {
    const s = String(str).slice(0, len);
    return right ? s.padStart(len) : s.padEnd(len);
  }

  try {
    const printer = new ThermalPrinter({
      type:      PrinterTypes.EPSON,
      interface: THERMAL_PRINTER_INTERFACE,
      width:     lineWidth,
      removeSpecialCharacters: false,
      lineCharacter: '-',
    });

    const isConnected = await printer.isPrinterConnected();
    if (!isConnected)
      throw new Error('Printer not reachable at ' + THERMAL_PRINTER_INTERFACE);

    // Header
    printer.alignCenter();
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.println('MACH CAFE');
    printer.bold(false);
    printer.setTextNormal();
    printer.println(branch ? branch.name : '');
    printer.println('Every cup crafted with care');
    printer.drawLine();

    // Meta
    printer.alignLeft();
    const ts = new Date(inv.timestamp);
    printer.println(inv.invoiceNo);
    printer.println(`${ts.toLocaleDateString('en-IN')} ${ts.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`);
    printer.println(`Table: ${inv.tableNo || 'Counter'}   Payment: ${inv.paymentMode || 'Cash'}`);
    if (customer) printer.println(`Customer: ${customer.name}${customer.phone ? ' · ' + customer.phone : ''}`);
    printer.drawLine();

    // Column headers
    printer.println(pad('Item', colNameW) + pad('Qty', colQtyW) + pad('Amt', colAmtW, true));
    printer.println('-'.repeat(lineWidth));

    // Items
    for (const item of items) {
      printer.println(pad(item.name, colNameW) + pad(item.qty, colQtyW) + pad('Rs.' + item.amount, colAmtW, true));
    }
    printer.drawLine();

    // Totals
    printer.println(pad('Subtotal', lineWidth - 10) + pad('Rs.' + inv.subtotal, 10, true));
    if (inv.cgst > 0) {
      printer.println(pad('CGST 2.5%', lineWidth - 10) + pad('Rs.' + inv.cgst, 10, true));
      printer.println(pad('SGST 2.5%', lineWidth - 10) + pad('Rs.' + inv.sgst, 10, true));
    }
    printer.println('='.repeat(lineWidth));
    printer.bold(true);
    printer.setTextSize(1, 1);
    printer.println(pad('TOTAL', lineWidth - 12) + pad('Rs.' + inv.grand, 12, true));
    printer.bold(false);
    printer.setTextNormal();
    printer.drawLine();

    // Footer
    printer.alignCenter();
    printer.println('Thank you for visiting!');
    printer.println('hello@mach.in');
    printer.cut();

    await printer.execute();
    res.json({ success: true, message: 'Printed successfully' });

  } catch (err) {
    console.error('Thermal print error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});
app.use('/api/cash', require('./routes/cash'));
// ── Start ───────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n☕  MACH Cafe running on http://localhost:${PORT}`);
  console.log(`\n📋  Database: mach.db`);
  console.log(`    To view: npx @sqlite-viewer/app mach.db`);
  console.log(`\n⚠️  Change JWT_SECRET in middleware/auth.js before going live!`);
});