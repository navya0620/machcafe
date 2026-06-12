// middleware/auth.js
const jwt    = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'mach-cafe-secret-change-me';

// ── Verify JWT from Authorization: Bearer <token> header ──
function verifyToken(req, res, next) {
  const auth  = req.headers['authorization'] || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token)
    return res.status(401).json({ success: false, error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    return res.status(403).json({ success: false, error: 'Invalid or expired token' });
  }
}

// ── Owner-only routes ──
function ownerOnly(req, res, next) {
  if (req.user?.role !== 'owner')
    return res.status(403).json({ success: false, error: 'Owner access required' });
  next();
}

// ── Manager or Owner ──
function managerOrOwner(req, res, next) {
  if (!['owner', 'manager'].includes(req.user?.role))
    return res.status(403).json({ success: false, error: 'Manager or Owner access required' });
  next();
}

// ── Resolve branch_id for any route that needs it ──
// Owner:   reads branch_id from query string or request body
// Others:  always locked to their own branch_id from the JWT
function resolveBranch(req, res, next) {
  if (req.user.role === 'owner') {
    const bid = parseInt(req.query.branch_id || req.body?.branch_id);
    if (!bid)
      return res.status(400).json({ success: false, error: 'branch_id is required for owner requests' });
    req.branch_id = bid;
  } else {
    if (!req.user.branch_id)
      return res.status(403).json({ success: false, error: 'Your account has no branch assigned. Contact the owner.' });
    req.branch_id = req.user.branch_id;
  }
  next();
}

module.exports = { verifyToken, ownerOnly, managerOrOwner, resolveBranch };