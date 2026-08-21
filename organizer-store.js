const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const DATA_FILE = path.join(__dirname, 'organizer-data.json');
const SALT_ROUNDS = 10;

// Roles in descending order of privilege.
const ROLES = ['OWNER', 'ADMIN', 'MODERATOR', 'MANAGER'];
const ROLE_RANK = { OWNER: 0, ADMIN: 1, MODERATOR: 2, MANAGER: 3 };

// Shape: { [id]: { id, username, passwordHash, role, displayName, disabled, mustChangePassword, createdAt, createdBy, updatedAt } }
let data = {};
try {
  if (fs.existsSync(DATA_FILE)) {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  }
} catch (err) {
  console.error('⚠️  Could not read organizer-data.json, starting fresh:', err.message);
  data = {};
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('⚠️  Could not save organizer-data.json:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateId() {
  return crypto.randomUUID();
}

function hashPassword(plaintext) {
  return bcrypt.hashSync(plaintext, SALT_ROUNDS);
}

function verifyPassword(plaintext, hash) {
  return bcrypt.compareSync(plaintext, hash);
}

/** True if roleA outranks roleB (lower rank number = higher privilege). */
function outranks(roleA, roleB) {
  return (ROLE_RANK[roleA] ?? 99) < (ROLE_RANK[roleB] ?? 99);
}

/** True if roleA is equal or higher privilege than roleB. */
function outranksOrEqual(roleA, roleB) {
  return (ROLE_RANK[roleA] ?? 99) <= (ROLE_RANK[roleB] ?? 99);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

function getAll() {
  return Object.values(data).map(sanitize);
}

function getById(id) {
  return data[id] || null;
}

function getByUsername(username) {
  const lower = (username || '').toLowerCase();
  return Object.values(data).find((u) => u.username.toLowerCase() === lower) || null;
}

/** Return public-safe user object (no password hash). */
function sanitize(user) {
  if (!user) return null;
  const { passwordHash, ...safe } = user;
  return safe;
}

/**
 * Create a new organizer account.
 * @param {object} opts - { username, password, role, displayName, createdBy }
 * @returns {{ success, user?, error? }}
 */
function createUser({ username, password, role, displayName, createdBy }) {
  if (!username || !password) return { success: false, error: 'Username and password required.' };
  if (!ROLES.includes(role)) return { success: false, error: `Invalid role. Must be one of: ${ROLES.join(', ')}` };
  if (getByUsername(username)) return { success: false, error: 'Username already exists.' };

  const id = generateId();
  const now = new Date().toISOString();
  data[id] = {
    id,
    username: username.trim(),
    passwordHash: hashPassword(password),
    role,
    displayName: displayName || username,
    disabled: false,
    mustChangePassword: true,
    createdAt: now,
    createdBy: createdBy || null,
    updatedAt: now,
  };
  save();
  return { success: true, user: sanitize(data[id]) };
}

/**
 * Update an existing organizer.
 * Fields that can be updated: displayName, role, disabled.
 */
function updateUser(id, updates, updatedBy) {
  const user = data[id];
  if (!user) return { success: false, error: 'User not found.' };

  if (updates.displayName !== undefined) user.displayName = updates.displayName;
  if (updates.role !== undefined) {
    if (!ROLES.includes(updates.role)) return { success: false, error: 'Invalid role.' };
    user.role = updates.role;
  }
  if (updates.disabled !== undefined) user.disabled = Boolean(updates.disabled);

  user.updatedAt = new Date().toISOString();
  save();
  return { success: true, user: sanitize(user) };
}

/**
 * Reset a user's password. Sets mustChangePassword = true.
 */
function resetPassword(id, newPassword) {
  const user = data[id];
  if (!user) return { success: false, error: 'User not found.' };
  user.passwordHash = hashPassword(newPassword);
  user.mustChangePassword = true;
  user.updatedAt = new Date().toISOString();
  save();
  return { success: true };
}

/**
 * Change password (used by the user themselves, e.g. first-login or settings).
 * Clears mustChangePassword flag.
 */
function changePassword(id, newPassword) {
  const user = data[id];
  if (!user) return { success: false, error: 'User not found.' };
  user.passwordHash = hashPassword(newPassword);
  user.mustChangePassword = false;
  user.updatedAt = new Date().toISOString();
  save();
  return { success: true };
}

/**
 * Delete an organizer account.
 */
function deleteUser(id) {
  if (!data[id]) return { success: false, error: 'User not found.' };
  delete data[id];
  save();
  return { success: true };
}

/**
 * Authenticate: verify username + password.
 * Returns the full user record (including passwordHash internally) or null.
 */
function authenticate(username, password) {
  const user = getByUsername(username);
  if (!user) return null;
  if (user.disabled) return null;
  if (!verifyPassword(password, user.passwordHash)) return null;
  return user;
}

/**
 * Seed the Owner account if none exists. Called once on startup.
 */
function seedOwner(username, password) {
  const existing = Object.values(data).find((u) => u.role === 'OWNER');
  if (existing) return { seeded: false, existing: sanitize(existing) };
  const result = createUser({
    username,
    password,
    role: 'OWNER',
    displayName: 'Owner',
    createdBy: 'system',
  });
  if (result.success) {
    // Owner doesn't need forced password change on first run (they set it themselves).
    data[result.user.id].mustChangePassword = false;
    save();
    result.user.mustChangePassword = false;
  }
  return { seeded: true, ...result };
}

/**
 * Count how many users exist.
 */
function count() {
  return Object.keys(data).length;
}

module.exports = {
  ROLES,
  ROLE_RANK,
  outranks,
  outranksOrEqual,
  getAll,
  getById,
  getByUsername,
  sanitize,
  createUser,
  updateUser,
  resetPassword,
  changePassword,
  deleteUser,
  authenticate,
  seedOwner,
  count,
  hashPassword,
  verifyPassword,
};
