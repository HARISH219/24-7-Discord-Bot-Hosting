/**
 * Organizer Dashboard API Routes
 * Mounted at /api/admin/* in the main Express app.
 */
const express = require('express');
const organizerStore = require('./organizer-store');
const auditStore = require('./audit-store');
const auth = require('./auth');
const store = require('./xp-store');
const pairStore = require('./pair-store');
const { levelForXp } = require('./leveling');

function createAdminRouter(getDiscordClient, getPendingPairRequests) {
  const router = express.Router();

  // =========================================================================
  // AUTH ROUTES (no auth required)
  // =========================================================================

  // POST /api/admin/auth/login
  router.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ success: false, error: 'Username and password required.' });
    }
    const user = organizerStore.authenticate(username, password);
    if (!user) {
      return res.status(401).json({ success: false, error: 'Invalid credentials.' });
    }
    const token = auth.signToken(user);
    const safe = organizerStore.sanitize(user);
    auditStore.record({
      actor: user.username,
      actorRole: user.role,
      action: 'auth.login',
      result: 'success',
    });
    res.json({ success: true, token, user: safe });
  });

  // =========================================================================
  // ALL ROUTES BELOW REQUIRE AUTH
  // =========================================================================
  router.use(auth.requireAuth);

  // GET /api/admin/auth/me — current user info
  router.get('/auth/me', (req, res) => {
    res.json({ success: true, user: organizerStore.sanitize(req.user) });
  });

  // POST /api/admin/auth/change-password
  router.post('/auth/change-password', (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters.' });
    }
    // If must_change_password, don't require current password (they don't know the temp one meaningfully)
    if (!req.user.mustChangePassword) {
      if (!currentPassword) {
        return res.status(400).json({ success: false, error: 'Current password required.' });
      }
      if (!organizerStore.verifyPassword(currentPassword, req.user.passwordHash)) {
        return res.status(401).json({ success: false, error: 'Current password is incorrect.' });
      }
    }
    organizerStore.changePassword(req.user.id, newPassword);
    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'auth.passwordChange',
      target: req.user.username,
      result: 'success',
    });
    // Issue new token (mustChangePassword is now false)
    const freshUser = organizerStore.getById(req.user.id);
    const token = auth.signToken(freshUser);
    res.json({ success: true, token, user: organizerStore.sanitize(freshUser) });
  });

  // =========================================================================
  // ORGANIZER MANAGEMENT (Admin+ only)
  // =========================================================================

  // GET /api/admin/organizers
  router.get('/organizers', auth.requirePermission('organizers.view'), (req, res) => {
    let users = organizerStore.getAll();
    // Admin cannot see Owner accounts (security hierarchy)
    if (req.user.role === 'ADMIN') {
      users = users.filter((u) => u.role !== 'OWNER');
    }
    // Admin cannot see other Admins unless they are an Owner
    if (req.user.role === 'ADMIN') {
      users = users.filter((u) => u.role !== 'ADMIN' || u.id === req.user.id);
    }
    res.json({ success: true, organizers: users });
  });

  // POST /api/admin/organizers — create new organizer
  router.post('/organizers', auth.requirePermission('organizers.create'), (req, res) => {
    const { username, password, role, displayName } = req.body;
    if (!username || !password || !role) {
      return res.status(400).json({ success: false, error: 'username, password, and role are required.' });
    }
    // Prevent privilege escalation
    if (!organizerStore.outranks(req.user.role, role) && req.user.role !== role) {
      // Admin can create MODERATOR and MANAGER but not OWNER or ADMIN
      if (req.user.role !== 'OWNER') {
        return res.status(403).json({ success: false, error: 'Cannot create an account at or above your own role level.' });
      }
    }
    // Only OWNER can create another OWNER or ADMIN
    if (role === 'OWNER' && req.user.role !== 'OWNER') {
      return res.status(403).json({ success: false, error: 'Only an Owner can create another Owner account.' });
    }
    if (role === 'ADMIN' && req.user.role !== 'OWNER') {
      return res.status(403).json({ success: false, error: 'Only the Owner can create Admin accounts.' });
    }

    const result = organizerStore.createUser({
      username,
      password,
      role,
      displayName,
      createdBy: req.user.username,
    });
    if (!result.success) {
      return res.status(400).json(result);
    }
    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'organizer.create',
      target: username,
      details: { role },
      result: 'success',
    });
    res.json(result);
  });

  // PUT /api/admin/organizers/:id — update organizer
  router.put('/organizers/:id', auth.requirePermission('organizers.edit'), (req, res) => {
    const target = organizerStore.getById(req.params.id);
    if (!target) return res.status(404).json({ success: false, error: 'User not found.' });

    // Cannot edit users at or above your own rank (unless you're Owner)
    if (req.user.role !== 'OWNER' && !organizerStore.outranks(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'Cannot edit a user at or above your role.' });
    }
    // Cannot change someone's role to OWNER
    if (req.body.role === 'OWNER') {
      return res.status(403).json({ success: false, error: 'Cannot elevate to Owner.' });
    }
    // Admin cannot elevate to ADMIN
    if (req.body.role === 'ADMIN' && req.user.role !== 'OWNER') {
      return res.status(403).json({ success: false, error: 'Only Owner can assign Admin role.' });
    }

    const result = organizerStore.updateUser(req.params.id, req.body, req.user.username);
    if (!result.success) return res.status(400).json(result);

    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'organizer.edit',
      target: target.username,
      details: { changes: Object.keys(req.body) },
      result: 'success',
    });
    res.json(result);
  });

  // POST /api/admin/organizers/:id/reset-password
  router.post('/organizers/:id/reset-password', auth.requirePermission('organizers.resetPassword'), (req, res) => {
    const target = organizerStore.getById(req.params.id);
    if (!target) return res.status(404).json({ success: false, error: 'User not found.' });

    if (req.user.role !== 'OWNER' && !organizerStore.outranks(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'Cannot reset password for a user at or above your role.' });
    }

    const { newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
    }

    const result = organizerStore.resetPassword(req.params.id, newPassword);
    if (!result.success) return res.status(400).json(result);

    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'organizer.resetPassword',
      target: target.username,
      result: 'success',
    });
    res.json({ success: true, message: 'Password reset. User must change it on next login.' });
  });

  // DELETE /api/admin/organizers/:id
  router.delete('/organizers/:id', auth.requirePermission('organizers.delete'), (req, res) => {
    const target = organizerStore.getById(req.params.id);
    if (!target) return res.status(404).json({ success: false, error: 'User not found.' });

    if (target.id === req.user.id) {
      return res.status(403).json({ success: false, error: 'Cannot delete your own account.' });
    }
    // Protect the primary owner account (harish)
    if (target.username === 'harish') {
      return res.status(403).json({ success: false, error: 'This account is protected and cannot be deleted.' });
    }
    if (req.user.role !== 'OWNER' && !organizerStore.outranks(req.user.role, target.role)) {
      return res.status(403).json({ success: false, error: 'Cannot delete a user at or above your role.' });
    }

    organizerStore.deleteUser(req.params.id);
    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'organizer.delete',
      target: target.username,
      result: 'success',
    });
    res.json({ success: true });
  });

  // =========================================================================
  // AUDIT LOGS (Owner + Admin only)
  // =========================================================================

  router.get('/logs', auth.requirePermission('logs.view'), (req, res) => {
    const { actor, action, target, limit, offset } = req.query;
    const result = auditStore.query({
      actor,
      action,
      target,
      limit: parseInt(limit) || 100,
      offset: parseInt(offset) || 0,
    });
    res.json({ success: true, ...result });
  });

  // =========================================================================
  // XP MANAGEMENT (Owner + Moderator)
  // =========================================================================

  const GUILD_ID = '1289894372887760991';

  // GET /api/admin/xp/members — all members with XP
  router.get('/xp/members', auth.requirePermission('xp.view'), (req, res) => {
    const lb = store.leaderboard(GUILD_ID, 200);
    const members = lb.map((entry) => {
      const { level } = levelForXp(entry.xp);
      const partner = pairStore.getPartner(GUILD_ID, entry.userId);
      return {
        id: entry.userId,
        username: entry.username,
        avatar: entry.avatar,
        xp: entry.xp,
        chatXp: entry.chatXp,
        voiceXp: entry.voiceXp,
        level,
        partnerId: partner,
      };
    });
    res.json({ success: true, members });
  });

  // POST /api/admin/xp/add — add XP to a user
  router.post('/xp/add', auth.requirePermission('xp.manage'), (req, res) => {
    const { userId, amount, reason } = req.body;
    if (!userId || !amount) {
      return res.status(400).json({ success: false, error: 'userId and amount required.' });
    }
    const amt = parseInt(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'Amount must be a positive number.' });
    }
    store.addXp(GUILD_ID, userId, amt, {}, 'chat');
    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'xp.add',
      target: userId,
      details: { amount: amt, reason: reason || null },
      result: 'success',
    });
    res.json({ success: true, message: `Added ${amt} XP to ${userId}.` });
  });

  // POST /api/admin/xp/remove — remove XP from a user
  router.post('/xp/remove', auth.requirePermission('xp.manage'), (req, res) => {
    const { userId, amount, reason } = req.body;
    if (!userId || !amount) {
      return res.status(400).json({ success: false, error: 'userId and amount required.' });
    }
    const amt = parseInt(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      return res.status(400).json({ success: false, error: 'Amount must be a positive number.' });
    }
    // Remove XP by adding negative (the store clamps at 0 internally via addXp)
    store.addXp(GUILD_ID, userId, -amt, {}, 'chat');
    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'xp.remove',
      target: userId,
      details: { amount: amt, reason: reason || null },
      result: 'success',
    });
    res.json({ success: true, message: `Removed ${amt} XP from ${userId}.` });
  });

  // POST /api/admin/xp/reset-user — reset a user's XP to 0
  router.post('/xp/reset-user', auth.requirePermission('xp.reset'), (req, res) => {
    const { userId, reason } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required.' });
    store.resetUser(GUILD_ID, userId);
    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'xp.resetUser',
      target: userId,
      details: { reason: reason || null },
      result: 'success',
    });
    res.json({ success: true, message: `Reset XP for ${userId}.` });
  });

  // POST /api/admin/xp/reset-all — reset all XP
  router.post('/xp/reset-all', auth.requirePermission('xp.reset'), (req, res) => {
    // Extra safety: only Owner can reset all
    if (req.user.role !== 'OWNER') {
      return res.status(403).json({ success: false, error: 'Only the Owner can reset all XP.' });
    }
    const { reason } = req.body;
    store.resetGuild(GUILD_ID);
    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'xp.resetAll',
      details: { reason: reason || null },
      result: 'success',
    });
    res.json({ success: true, message: 'All XP has been reset.' });
  });

  // =========================================================================
  // COUPLE / PAIRING MANAGEMENT (Owner + Manager)
  // =========================================================================

  // GET /api/admin/couples — list all pairs
  router.get('/couples', auth.requirePermission('couples.view'), (req, res) => {
    const pairs = pairStore.listPairs(GUILD_ID).map(([a, b]) => {
      const m1 = memberInfoSimple(a);
      const m2 = memberInfoSimple(b);
      return {
        pairId: [a, b].sort().join('-'),
        members: [m1, m2],
        totalXp: m1.xp + m2.xp,
      };
    });
    pairs.sort((x, y) => y.totalXp - x.totalXp);
    res.json({ success: true, couples: pairs });
  });

  // POST /api/admin/couples/pair — initiate a pair request via Discord
  router.post('/couples/pair', auth.requirePermission('couples.pair'), (req, res) => {
    const { userId1, userId2 } = req.body;
    if (!userId1 || !userId2) {
      return res.status(400).json({ success: false, error: 'userId1 and userId2 required.' });
    }
    if (userId1 === userId2) {
      return res.status(400).json({ success: false, error: 'Cannot pair a user with themselves.' });
    }

    // Check neither is already paired
    const cur1 = pairStore.getPartner(GUILD_ID, userId1);
    if (cur1) return res.status(400).json({ success: false, error: `User ${userId1} is already paired.` });
    const cur2 = pairStore.getPartner(GUILD_ID, userId2);
    if (cur2) return res.status(400).json({ success: false, error: `User ${userId2} is already paired.` });

    // Check no pending request exists for either user
    const pending = getPendingPairRequests();
    for (const req2 of pending.values()) {
      if (req2.guildId !== GUILD_ID) continue;
      if ([req2.user1.id, req2.user2.id].some((id) => id === userId1 || id === userId2)) {
        return res.status(400).json({ success: false, error: 'A pending pair request already exists for one of these users.' });
      }
    }

    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'pair.request',
      target: `${userId1} + ${userId2}`,
      details: { source: 'web' },
      result: 'pending',
    });

    // Emit event for Discord bot to send pair request — handled by caller
    res.json({
      success: true,
      message: 'Pair request will be sent via Discord. Both users must accept.',
      userId1,
      userId2,
      source: 'web',
    });
  });

  // POST /api/admin/couples/force-pair — Owner-only direct pair (bypass consent)
  router.post('/couples/force-pair', auth.requirePermission('force.pair'), (req, res) => {
    const { userId1, userId2, reason } = req.body;
    if (!userId1 || !userId2) {
      return res.status(400).json({ success: false, error: 'userId1 and userId2 required.' });
    }
    if (userId1 === userId2) {
      return res.status(400).json({ success: false, error: 'Cannot pair a user with themselves.' });
    }
    const cur1 = pairStore.getPartner(GUILD_ID, userId1);
    if (cur1) return res.status(400).json({ success: false, error: `User ${userId1} is already paired.` });
    const cur2 = pairStore.getPartner(GUILD_ID, userId2);
    if (cur2) return res.status(400).json({ success: false, error: `User ${userId2} is already paired.` });

    pairStore.pair(GUILD_ID, userId1, userId2);
    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'pair.forcePair',
      target: `${userId1} + ${userId2}`,
      details: { reason: reason || 'Owner override', source: 'web' },
      result: 'success',
    });
    res.json({ success: true, message: 'Users have been force-paired (Owner override).' });
  });

  // POST /api/admin/couples/unpair — unpair a couple
  router.post('/couples/unpair', auth.requirePermission('couples.unpair'), (req, res) => {
    const { userId, reason } = req.body;
    if (!userId) return res.status(400).json({ success: false, error: 'userId required.' });
    const partner = pairStore.getPartner(GUILD_ID, userId);
    if (!partner) return res.status(400).json({ success: false, error: 'User is not paired.' });

    pairStore.unpair(GUILD_ID, userId);
    auditStore.record({
      actor: req.user.username,
      actorRole: req.user.role,
      action: 'pair.unpair',
      target: `${userId} + ${partner}`,
      details: { reason: reason || null, source: 'web' },
      result: 'success',
    });
    res.json({ success: true, message: `Unpaired ${userId} and ${partner}.`, partner });
  });

  // =========================================================================
  // ROLES INFO
  // =========================================================================

  router.get('/roles', auth.requireAuth, (req, res) => {
    const roles = organizerStore.ROLES.map((r) => ({
      name: r,
      permissions: auth.getPermissionsForRole(r),
    }));
    res.json({ success: true, roles });
  });

  // =========================================================================
  // Helper
  // =========================================================================

  function memberInfoSimple(userId) {
    const stats = store.getUser(GUILD_ID, userId);
    const client = getDiscordClient();
    const cached = client?.users?.cache?.get(userId);
    return {
      id: userId,
      username: stats.username || cached?.username || 'Member',
      avatar: stats.avatar || cached?.displayAvatarURL?.() || null,
      xp: stats.xp,
      chatXp: stats.chatXp,
      voiceXp: stats.voiceXp,
      level: levelForXp(stats.xp).level,
    };
  }

  return router;
}

module.exports = createAdminRouter;
