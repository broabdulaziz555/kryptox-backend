const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

// ─── STATIC ROUTES FIRST (must precede /:username wildcard) ──────────────────

// GET /users/search?q=aziz
router.get('/search', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { q } = req.query;
  if (!q || q.trim().length < 1) return res.json({ users: [] });
  try {
    const users = await prisma.user.findMany({
      where: { username: { contains: q.toLowerCase().trim(), mode: 'insensitive' } },
      select: { username: true, avatar: true, bio: true, isBusiness: true, isVerified: true, isPremium: true },
      take: 20
    });
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: 'Search failed' });
  }
});

// GET /users/me/profile (authenticated) — MUST be before /:username
router.get('/me/profile', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true, username: true, email: true, publicAddress: true,
        avatar: true, bio: true, isBusiness: true, isVerified: true,
        isPremium: true, isEmailVerified: true, preferredLanguage: true,
        demoBalances: true, createdAt: true
      }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    user.demoBalances = JSON.parse(user.demoBalances || '{}');
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to get profile' });
  }
});

// PUT /users/me/profile (authenticated)
router.put('/me/profile', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  const { bio, avatar, preferredLanguage, isBusiness } = req.body;
  try {
    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        ...(bio !== undefined && { bio }),
        ...(avatar !== undefined && { avatar }),
        ...(preferredLanguage && { preferredLanguage }),
        ...(isBusiness !== undefined && { isBusiness })
      },
      select: { username: true, email: true, avatar: true, bio: true, isBusiness: true, isVerified: true, preferredLanguage: true }
    });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ─── DYNAMIC ROUTES (after statics) ──────────────────────────────────────────

// GET /users/:username
router.get('/:username', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const user = await prisma.user.findUnique({
      where: { username: req.params.username.toLowerCase() },
      select: { username: true, publicAddress: true, avatar: true, bio: true, isBusiness: true, isVerified: true, isPremium: true, createdAt: true }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ user });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// GET /users/:username/qr
router.get('/:username/qr', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const user = await prisma.user.findUnique({
      where: { username: req.params.username.toLowerCase() },
      select: { username: true, publicAddress: true, isBusiness: true }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });
    const appUrl = process.env.FRONTEND_URL || 'https://kryptox.app';
    res.json({
      qrData: user.isBusiness ? `${appUrl}/biz/${user.username}` : `${appUrl}/u/${user.username}`,
      address: user.publicAddress,
      username: user.username
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get QR data' });
  }
});

module.exports = router;
