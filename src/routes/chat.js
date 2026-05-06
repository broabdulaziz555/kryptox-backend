const express = require('express');
const router  = express.Router();
const auth    = require('../middleware/auth');

// ─── GET /chat/conversations ──────────────────────────────────────────────────
router.get('/conversations', auth, async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { fromUsername: req.user.username },
          { toUsername:   req.user.username },
        ],
      },
      orderBy: { createdAt: 'desc' },
    });

    // Group into conversation threads, skip unclaimed viral-link 'pending'
    const convMap = {};
    for (const msg of messages) {
      const partner =
        msg.fromUsername === req.user.username ? msg.toUsername : msg.fromUsername;
      if (partner === 'pending') continue;
      if (!convMap[partner]) {
        convMap[partner] = { username: partner, lastMessage: msg, unreadCount: 0 };
      }
      // Count unread: messages TO me that aren't CONFIRMED
      if (msg.toUsername === req.user.username && msg.status === 'SENT') {
        convMap[partner].unreadCount++;
      }
    }

    // Enrich with user metadata
    const partners = Object.keys(convMap);
    const users    = await prisma.user.findMany({
      where:  { username: { in: partners } },
      select: { username: true, avatar: true, isVerified: true, isBusiness: true },
    });
    const userMap = Object.fromEntries(users.map(u => [u.username, u]));

    const conversations = Object.values(convMap)
      .sort((a, b) => new Date(b.lastMessage.createdAt) - new Date(a.lastMessage.createdAt))
      .map(c => ({ ...c, user: userMap[c.username] || { username: c.username } }));

    res.json(conversations);
  } catch (err) {
    console.error('conversations error:', err);
    res.status(500).json({ error: 'Failed to load conversations' });
  }
});

// ─── GET /chat/:username ──────────────────────────────────────────────────────
router.get('/:username', auth, async (req, res) => {
  const prisma = req.app.get('prisma');
  const { username } = req.params;
  const { limit = 50, before } = req.query;

  try {
    const messages = await prisma.message.findMany({
      where: {
        OR: [
          { fromUsername: req.user.username, toUsername: username },
          { fromUsername: username,           toUsername: req.user.username },
        ],
        ...(before && { createdAt: { lt: new Date(before) } }),
      },
      orderBy: { createdAt: 'asc' },
      take:    parseInt(limit),
    });
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// ─── POST /chat/send ──────────────────────────────────────────────────────────
router.post('/send', auth, async (req, res) => {
  const prisma = req.app.get('prisma');
  const io     = req.app.get('io');
  const { toUsername, text, amount, currency, type } = req.body;

  if (!toUsername) return res.status(400).json({ error: 'toUsername required' });
  if (!text && !(amount && currency)) {
    return res.status(400).json({ error: 'Provide text or amount+currency' });
  }

  try {
    const receiver = await prisma.user.findUnique({
      where: { username: toUsername.toLowerCase() },
    });
    if (!receiver) {
      return res.status(404).json({
        error: 'User not found. Use /wallet/viral-link to send to non-users.',
      });
    }

    const msgType = type || 'TEXT';

    const message = await prisma.message.create({
      data: {
        fromUsername: req.user.username,
        toUsername:   toUsername.toLowerCase(),
        text:         text || null,
        amount:       amount ? parseFloat(amount) : null,
        currency:     currency ? currency.toUpperCase() : null,
        type:         msgType,
        status:       'SENT',
      },
    });

    // Demo payment — process balance transfer immediately
    if (process.env.DEMO_MODE === 'true' && msgType === 'PAYMENT' && amount && currency) {
      const ok = await processDemoPayment(
        prisma, req.user.username, toUsername, parseFloat(amount), currency
      );
      if (!ok) {
        // Roll back message creation
        await prisma.message.delete({ where: { id: message.id } });
        return res.status(400).json({ error: 'Insufficient balance' });
      }
      await prisma.message.update({ where: { id: message.id }, data: { status: 'CONFIRMED' } });
      message.status = 'CONFIRMED';
    }

    io.to(toUsername.toLowerCase()).emit('new_message', message);
    res.status(201).json(message);
  } catch (err) {
    console.error('chat send error:', err);
    res.status(500).json({ error: 'Failed to send message' });
  }
});

// ─── POST /chat/request ───────────────────────────────────────────────────────
router.post('/request', auth, async (req, res) => {
  const prisma = req.app.get('prisma');
  const io     = req.app.get('io');
  const { toUsername, amount, currency, text } = req.body;

  if (!toUsername || !amount || !currency) {
    return res.status(400).json({ error: 'toUsername, amount, currency required' });
  }

  try {
    const message = await prisma.message.create({
      data: {
        fromUsername: req.user.username,
        toUsername:   toUsername.toLowerCase(),
        text:         text || null,
        amount:       parseFloat(amount),
        currency:     currency.toUpperCase(),
        type:         'REQUEST',
        status:       'SENT',
      },
    });
    io.to(toUsername.toLowerCase()).emit('new_message', message);
    res.status(201).json(message);
  } catch (err) {
    res.status(500).json({ error: 'Failed to send request' });
  }
});

// ─── PUT /chat/request/:id/accept ─────────────────────────────────────────────
router.put('/request/:id/accept', auth, async (req, res) => {
  const prisma = req.app.get('prisma');
  const io     = req.app.get('io');
  try {
    const message = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!message)                               return res.status(404).json({ error: 'Request not found' });
    if (message.toUsername !== req.user.username) return res.status(403).json({ error: 'Not authorized' });
    if (message.type   !== 'REQUEST')           return res.status(400).json({ error: 'Not a payment request' });
    if (message.status !== 'SENT')              return res.status(400).json({ error: 'Request already processed' });

    if (process.env.DEMO_MODE === 'true') {
      const ok = await processDemoPayment(
        prisma, req.user.username, message.fromUsername, message.amount, message.currency
      );
      if (!ok) return res.status(400).json({ error: 'Insufficient balance' });
    }

    const updated = await prisma.message.update({
      where: { id: req.params.id },
      data:  { status: 'CONFIRMED' },
    });

    io.to(message.fromUsername).emit('payment_confirmed', updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to accept request' });
  }
});

// ─── PUT /chat/request/:id/decline ───────────────────────────────────────────
router.put('/request/:id/decline', auth, async (req, res) => {
  const prisma = req.app.get('prisma');
  const io     = req.app.get('io');
  try {
    const message = await prisma.message.findUnique({ where: { id: req.params.id } });
    if (!message)                               return res.status(404).json({ error: 'Request not found' });
    if (message.toUsername !== req.user.username) return res.status(403).json({ error: 'Not authorized' });
    if (message.status !== 'SENT')              return res.status(400).json({ error: 'Request already processed' });

    const updated = await prisma.message.update({
      where: { id: req.params.id },
      data:  { status: 'DECLINED' },
    });

    io.to(message.fromUsername).emit('payment_declined', updated);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Failed to decline request' });
  }
});

// ─── Helper: transfer demo balances, returns true on success ─────────────────
async function processDemoPayment(prisma, fromUsername, toUsername, amount, currency) {
  const [sender, receiver] = await Promise.all([
    prisma.user.findUnique({ where: { username: fromUsername } }),
    prisma.user.findUnique({ where: { username: toUsername } }),
  ]);
  if (!sender || !receiver) return false;

  const senderBal   = JSON.parse(sender.demoBalances   || '{}');
  const receiverBal = JSON.parse(receiver.demoBalances || '{}');
  const coin        = currency.toUpperCase();

  if ((senderBal[coin] || 0) < amount) return false; // insufficient — caller handles error

  senderBal[coin]   = (senderBal[coin]   || 0) - amount;
  receiverBal[coin] = (receiverBal[coin] || 0) + amount;

  await Promise.all([
    prisma.user.update({ where: { username: fromUsername }, data: { demoBalances: JSON.stringify(senderBal) } }),
    prisma.user.update({ where: { username: toUsername   }, data: { demoBalances: JSON.stringify(receiverBal) } }),
  ]);
  return true;
}

module.exports = router;
