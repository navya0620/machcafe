// seed-branches.js
// Run ONCE after creating db.js:  node seed-branches.js

const db = require('./db');

const branches = [
  {
    name: 'Guntupalli',
    slug: 'guntupalli',
    location: 'Vijayawada, Andhra Pradesh',
    phone: '+91 9952949948',
    email: 'guntupalli@mach.in',
    hours: '24/7',
    seating: 48,
    icon: '🏘️',
    color_class: 'band-guntupalli',
    is_active: 1
  },
  {
    name: 'Ongole',
    slug: 'ongole',
    location: 'Ongole, Andhra Pradesh',
    phone: '+91 98765 43211',
    email: 'ongole@mach.in',
    hours: '24/7',
    seating: 36,
    icon: '🌊',
    color_class: 'band-ongole',
    is_active: 1
  },
  {
    name: 'Kodaikanal',
    slug: 'kodaikanal',
    location: 'Kodaikanal, Tamil Nadu',
    phone: '+91 98765 43212',
    email: 'kodaikanal@mach.in',
    hours: '24/7',
    seating: 30,
    icon: '⛰️',
    color_class: 'band-kodaikanal',
    is_active: 1
  },
];

const insert = db.prepare(`
  INSERT OR IGNORE INTO branches
    (name, slug, location, phone, email, hours, seating, icon, color_class, is_active)
  VALUES
    (@name, @slug, @location, @phone, @email, @hours, @seating, @icon, @color_class, @is_active)
`);

const insertMany = db.transaction((list) => {
  for (const branch of list) insert.run(branch);
});

insertMany(branches);

// Confirm what was inserted
const all = db.prepare('SELECT id, name, slug FROM branches').all();
console.log('✅  Branches in DB:');
all.forEach(b => console.log(`   [${b.id}] ${b.name}  (slug: ${b.slug})`));