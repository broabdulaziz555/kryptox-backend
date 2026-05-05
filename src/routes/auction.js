const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

// GET /auction/active
router.get('/active', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const now = new Date();
    // Auto-end expired auctions and set winner
    const expired = await prisma.auction.findMany({
      where: { status: 'ACTIVE', endsAt: { lt: now } }
    });
    for (const a of expired) {
      await prisma.auction.update({
        where: { id: a.id },
        data: { status: 'ENDED', winnerUsername: a.currentBidder || null }
      });
    }
    const auctions = await prisma.auction.findMany({
      where: { status: 'ACTIVE' },
      orderBy: { endsAt: 'asc' }
    });
    res.json({ auctions });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to load auctions' });
  }
});

// GET /auction/ended
router.get('/ended', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const auctions = await prisma.auction.findMany({
      where: { status: 'ENDED' },
      orderBy: { endsAt: 'desc' },
      take: 20
    });
    res.json({ auctions });
  } catch (err) {
    res.status(500).json({ error: 'Failed to load ended auctions' });
  }
});

// GET /auction/:username
router.get('/:username', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const auction = await prisma.auction.findUnique({
      where: { username: req.params.username.toLowerCase() }
    });
    if (!auction) return res.status(404).json({ error: 'Auction not found' });
    res.json({ auction });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get auction' });
  }
});

// POST /auction/bid
router.post('/bid', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  const io = req.app.get('io');
  const { username, amount } = req.body; // fixed: was 'bidAmount', now 'amount'

  if (!username || !amount) {
    return res.status(400).json({ error: 'username and amount required' });
  }

  try {
    const auction = await prisma.auction.findUnique({
      where: { username: username.toLowerCase() }
    });

    if (!auction) return res.status(404).json({ error: 'Auction not found' });
    if (auction.status !== 'ACTIVE') return res.status(400).json({ error: 'Auction is not active' });
    if (new Date() > auction.endsAt) {
      await prisma.auction.update({
        where: { id: auction.id },
        data: { status: 'ENDED', winnerUsername: auction.currentBidder || null }
      });
      return res.status(400).json({ error: 'Auction has ended' });
    }
    if (auction.currentBidder === req.user.username) {
      return res.status(400).json({ error: 'You are already the highest bidder' });
    }

    const bid = parseFloat(amount);
    if (isNaN(bid) || bid <= 0) return res.status(400).json({ error: 'Invalid bid amount' });
    if (bid <= auction.currentBid) {
      return res.status(400).json({ error: `Bid must be higher than ${auction.currentBid} USDT` });
    }

    // Demo: check balance
    if (process.env.DEMO_MODE === 'true') {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      const bal = JSON.parse(user.demoBalances || '{}');
      if ((bal['USDT'] || 0) < bid) {
        return res.status(400).json({ error: `Insufficient USDT balance (you have ${bal['USDT'] || 0} USDT)` });
      }
    }

    const updated = await prisma.auction.update({
      where: { id: auction.id },
      data: {
        currentBid: bid,
        currentBidder: req.user.username,
        bidCount: { increment: 1 }
      }
    });

    io.emit('bid_update', updated);
    res.json({ success: true, auction: updated });
  } catch (err) {
    console.error('Bid error:', err);
    res.status(500).json({ error: 'Failed to place bid' });
  }
});

module.exports = router;
