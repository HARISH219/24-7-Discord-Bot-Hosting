const jwt = require('jsonwebtoken');
const organizerStore = require('./organizer-store');

// JWT secret — use env or generate a random one per process (restarting invalidates sessions).
const JWT_SECRET = process.env.JWT_SECRET || require('crypto').randomBytes(32).toString('hex');
const JWT_EXPIRES_IN = '12h';

// ---------------------------------------------------------------------------
// Permission definitions per role
// ---------------------------------------------------------------------------
// Each permission is a dot-separated string (e.g. 'xp.manage', 'couples.pair').
// The check is: does the user's role include this permission?

const ROLE_PERMISSIONS = {
  OWNER: [
    'dashboard.view',
    'contestants.view',
    'couples.view',
    'couples.pair',
    'couples.unpair',
    'xp.view',
    'xp.manage',
    'xp.reset',
    'organizers.view',
    'organizers.create',
    'organizers.edit',
    'organizers.disable',
    'organizers.delete',
    'organizers.resetPassword',
    'roles.manage',
    'logs.view',
    'settings.manage',
    'force.pair', // bypass consent (emergency)
  ],
  ADMIN: [
    'dashboard.view',
    'contestants.view',
    'couples.view',
    'organizers.view',
    'organizers.create',
    'organizers.edit',
    'organizers.disable',
    'organizers.resetPassword',
    'roles.manage',
    'logs.view',
  ],
  MODERATOR: [
    'dashboard.view',
    'contestants.view',
    'couples.view',
    'xp.view',
    'xp.manage',
    'xp.reset',
  ],
  MANAGER: [
    'dashboard.view',
    'contestants.view',
    'couples.view',
    'couples.pair',
  ],
};

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function signToken(user) {
  const payload = {
    sub: user.id,
    username: user.username,
    role: user.role,
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Express middleware
// ---------------------------------------------------------------------------

/**
 * Middleware: require a valid JWT. Attaches req.user (full user record from store).
 * Returns 401 if no valid token.
 */
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Authentication required.' });
  }
  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ success: false, error: 'Invalid or expired token.' });
  }
  // Load fresh user record (in case role/disabled changed since token issued)
  const user = organizerStore.getById(payload.sub);
  if (!user || user.disabled) {
    return res.status(401).json({ success: false, error: 'Account disabled or not found.' });
  }
  req.user = user;
  next();
}

/**
 * Middleware factory: require one or more permissions.
 * Usage: requirePermission('xp.manage')
 *        requirePermission('couples.pair', 'couples.unpair')  // any one of these
 */
function requirePermission(...perms) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ success: false, error: 'Authentication required.' });
    }
    const userPerms = ROLE_PERMISSIONS[req.user.role] || [];
    const hasAny = perms.some((p) => userPerms.includes(p));
    if (!hasAny) {
      return res.status(403).json({ success: false, error: 'Insufficient permissions.' });
    }
    next();
  };
}

/**
 * Check if a role has a specific permission (without middleware context).
 */
function roleHasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role] || [];
  return perms.includes(permission);
}

/**
 * Get all permissions for a role.
 */
function getPermissionsForRole(role) {
  return ROLE_PERMISSIONS[role] || [];
}

module.exports = {
  JWT_SECRET,
  ROLE_PERMISSIONS,
  signToken,
  verifyToken,
  requireAuth,
  requirePermission,
  roleHasPermission,
  getPermissionsForRole,
};
