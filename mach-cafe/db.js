// db.js
const Database = require('better-sqlite3');
const path     = require('path');

const db = new Database(path.join(__dirname, 'mach.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`

  /* ── BRANCHES ──────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS branches (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    slug        TEXT NOT NULL UNIQUE,
    location    TEXT,
    phone       TEXT,
    email       TEXT,
    address     TEXT,
    hours       TEXT DEFAULT '24/7',
    seating     INTEGER DEFAULT 0,
    icon        TEXT DEFAULT '🏘️',
    color_class TEXT DEFAULT 'band-default',
    is_active   INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── USERS ──────────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT NOT NULL UNIQUE,
    password        TEXT NOT NULL,
    plain_password  TEXT,
    role        TEXT NOT NULL,
    branch_id   INTEGER REFERENCES branches(id) ON DELETE SET NULL,
    is_active   INTEGER DEFAULT 1,
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── MENU ITEMS ─────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS menu_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id    INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    description  TEXT,
    price        REAL NOT NULL,
    section      TEXT NOT NULL,
    category     TEXT NOT NULL DEFAULT 'beverage',
    emoji        TEXT DEFAULT '☕',
    badge        TEXT,
    isFeatured   INTEGER DEFAULT 0,
    is_available INTEGER DEFAULT 1,
    created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── INGREDIENTS ────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS ingredients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id     INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    unit          TEXT NOT NULL DEFAULT 'units',
    currentQty    REAL NOT NULL DEFAULT 0,
    reorderLevel  REAL NOT NULL DEFAULT 10,
    category      TEXT NOT NULL DEFAULT 'Other',
    created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(branch_id, name)
  );

  /* ── RECIPE LINKS ───────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS menu_item_ingredients (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    menuItemId    INTEGER NOT NULL REFERENCES menu_items(id) ON DELETE CASCADE,
    ingredientId  INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
    qtyPerServing REAL NOT NULL DEFAULT 1,
    UNIQUE(menuItemId, ingredientId)
  );

  /* ── INVENTORY LOGS ─────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS inventory_logs (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    itemId    INTEGER REFERENCES ingredients(id) ON DELETE SET NULL,
    logType   TEXT NOT NULL,
    delta     REAL NOT NULL,
    newQty    REAL NOT NULL,
    note      TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── CUSTOMERS ──────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL UNIQUE,
    email      TEXT,
    address    TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── INVOICES ───────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS invoices (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id   INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    invoiceNo   TEXT NOT NULL UNIQUE,
    customerId  INTEGER NOT NULL REFERENCES customers(id),
    tableNo     TEXT NOT NULL DEFAULT 'Counter',
    paymentMode TEXT NOT NULL DEFAULT 'Cash',
    status      TEXT NOT NULL DEFAULT 'PENDING',
    subtotal    INTEGER NOT NULL,
    cgst        INTEGER NOT NULL,
    sgst        INTEGER NOT NULL,
    grand       INTEGER NOT NULL,
    timestamp   DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  /* ── ORDER LINE-ITEMS ───────────────────────────────── */
  CREATE TABLE IF NOT EXISTS order_items (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    invoiceId INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    name      TEXT NOT NULL,
    qty       INTEGER NOT NULL,
    rate      INTEGER NOT NULL,
    amount    INTEGER NOT NULL
  );

  /* ── PARKED ORDERS ──────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS parked_orders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id  INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    token      TEXT NOT NULL UNIQUE,
    tableNo    TEXT NOT NULL DEFAULT 'Counter',
    subtotal   INTEGER NOT NULL DEFAULT 0,
    gst        INTEGER NOT NULL DEFAULT 0,
    grand      INTEGER NOT NULL DEFAULT 0,
    status     TEXT NOT NULL DEFAULT 'PARKED',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS parked_order_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    parkedOrderId INTEGER NOT NULL REFERENCES parked_orders(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    emoji         TEXT NOT NULL DEFAULT '☕',
    qty           INTEGER NOT NULL,
    rate          INTEGER NOT NULL,
    amount        INTEGER NOT NULL
  );

  /* ── PRINTER CONFIG ─────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS printer_configs (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id    INTEGER NOT NULL UNIQUE REFERENCES branches(id) ON DELETE CASCADE,
    printer_ip   TEXT,
    printer_port INTEGER DEFAULT 9100,
    header_text  TEXT,
    footer_text  TEXT,
    updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
  );
/* ── MENU SECTIONS ─────────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS menu_sections (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id   INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    slug        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT '🍽️',
    title       TEXT NOT NULL,
    description TEXT DEFAULT '',
    sort_order  INTEGER DEFAULT 0,
    is_active   INTEGER DEFAULT 1,
    UNIQUE(branch_id, slug)
  );
  CREATE INDEX IF NOT EXISTS idx_sec_branch ON menu_sections(branch_id);
  /* ── INDEXES ────────────────────────────────────────── */
  CREATE INDEX IF NOT EXISTS idx_menu_branch    ON menu_items(branch_id);
  CREATE INDEX IF NOT EXISTS idx_ing_branch     ON ingredients(branch_id);
  CREATE INDEX IF NOT EXISTS idx_inv_branch     ON invoices(branch_id);
  CREATE INDEX IF NOT EXISTS idx_inv_cust       ON invoices(customerId);
  CREATE INDEX IF NOT EXISTS idx_inv_ts         ON invoices(timestamp);
  CREATE INDEX IF NOT EXISTS idx_oi_inv         ON order_items(invoiceId);
  CREATE INDEX IF NOT EXISTS idx_mii_item       ON menu_item_ingredients(menuItemId);
  CREATE INDEX IF NOT EXISTS idx_log_branch     ON inventory_logs(branch_id);
  CREATE INDEX IF NOT EXISTS idx_log_item       ON inventory_logs(itemId);
  CREATE INDEX IF NOT EXISTS idx_parked_branch  ON parked_orders(branch_id);
  /* ── CASH REGISTER ─────────────────────────────────── */
  CREATE TABLE IF NOT EXISTS cash_register (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    branch_id    INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    date         TEXT NOT NULL,
    opening_cash REAL,
    closing_cash REAL,
    opened_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    closed_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
    opened_at    DATETIME,
    closed_at    DATETIME,
    UNIQUE(branch_id, date)
  );

  CREATE INDEX IF NOT EXISTS idx_cash_branch_date ON cash_register(branch_id, date);
`);
// ── MIGRATIONS ──────────────────────────────────────────
// Add plain_password column if it doesn't exist yet
try {
  db.exec(`ALTER TABLE users ADD COLUMN plain_password TEXT;`);
} catch (e) {
  // Column already exists — safe to ignore
}
module.exports = db;