// _auth.js — paste <script src="/_auth.js"></script> at top of every page

const TOKEN      = () => localStorage.getItem('mach_token') || '';
const BRANCH_ID  = () => parseInt(sessionStorage.getItem('mach_branch_id'));
const BRANCH_NAME = () => sessionStorage.getItem('mach_branch_name') || 'Branch';
const ROLE       = () => sessionStorage.getItem('mach_role') || '';

// Universal API helper — auto-appends branch_id for owners
async function api(url, method = 'GET', body = null) {
  const role  = ROLE();
  const sep   = url.includes('?') ? '&' : '?';
  const bParam = (role === 'owner' && BRANCH_ID()) ? `${sep}branch_id=${BRANCH_ID()}` : '';

  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + TOKEN()
    }
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url + bParam, opts);
  return res.json();
}

// Auth guard — call at top of every page
// allowedRoles: array like ['kitchen','manager','owner'] or null for any logged-in user
function requireAuth(allowedRoles) {
  const role  = ROLE();
  const token = TOKEN();
  if (!role || !token) { window.location.href = '/index.html'; return false; }
  if (allowedRoles && !allowedRoles.includes(role)) {
    window.location.href = '/index.html'; return false;
  }
  return true;
}