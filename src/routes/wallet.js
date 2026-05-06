const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');
const { v4: uuidv4 } = require('uuid');

const FALLBACK_PRICES = {
  BTC: 65000, ETH: 3200, USDT: 1, USDC: 1, BNB: 580,
  SOL: 145, TRX: 0.12, TON: 5.8, XRP: 0.55, ADA: 0.45,
  DOGE: 0.16, AVAX: 35, MATIC: 0.85, DOT: 7.2, LTC: 85,
  LINK: 14, UNI: 8.5, ATOM: 8, DAI: 1, BUSD: 1
};

async function getPriceMap(prisma) {
  try {
    const caches = await prisma.priceCache.findMany();
    const map = {};
    for (const p of caches) map[p.symbol] = { price: p.priceUSD, change24h: p.change24h };
    // Fill missing with fallbacks
    for (const [k, v] of Object.entries(FALLBACK_PRICES)) {
      if (!map[k]) map[k] = { price: v, change24h: 0 };
    }
    return map;
  } catch {
    return Object.fromEntries(Object.entries(FALLBACK_PRICES).map(([k, v]) => [k, { price: v, change24h: 0 }]));
  }
}

// GET /wallet/balances
router.get('/balances', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: { demoBalances: true, publicAddress: true }
    });
    const balances = JSON.parse(user.demoBalances || '{}');
    const prices = await getPriceMap(prisma);

    const result = Object.entries(balances)
      .filter(([, amount]) => amount > 0)
      .map(([symbol, amount]) => ({
        symbol,
        amount,
        price: prices[symbol]?.price || 0,
        usdValue: amount * (prices[symbol]?.price || 0),
        change24h: prices[symbol]?.change24h || 0
      }))
      .sort((a, b) => b.usdValue - a.usdValue);

    const totalUSD = result.reduce((s, b) => s + b.usdValue, 0);
    res.json({ balances: result, totalUSD, address: user.publicAddress });
  } catch (err) {
    console.error('Balances error:', err);
    res.status(500).json({ error: 'Failed to fetch balances' });
  }
});

// GET /wallet/transactions
router.get('/transactions', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  const { currency, limit = 20 } = req.query;
  try {
    const messages = await prisma.message.findMany({
      where: {
        OR: [{ fromUsername: req.user.username }, { toUsername: req.user.username }],
        type: { in: ['PAYMENT', 'RECEIPT'] },
        ...(currency && { currency: currency.toUpperCase() })
      },
      orderBy: { createdAt: 'desc' },
      take: parseInt(limit)
    });
    res.json({ transactions: messages });
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch transactions' });
  }
});

// POST /wallet/send
router.post('/send', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  const io = req.app.get('io');
  // Accept both 'currency' and 'coin' for compatibility
  const { toUsername, amount, currency, coin, note } = req.body;
  const coinSymbol = (currency || coin || '').toUpperCase();

  if (!toUsername || !amount || !coinSymbol) {
    return res.status(400).json({ error: 'toUsername, amount, and currency are required' });
  }

  try {
    const [sender, receiver] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.user.id } }),
      prisma.user.findUnique({ where: { username: toUsername.toLowerCase() } })
    ]);

    if (!receiver) return res.status(404).json({ error: 'User not found' });
    if (receiver.id === sender.id) return res.status(400).json({ error: 'Cannot send to yourself' });

    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    if (process.env.DEMO_MODE === 'true') {
      const senderBal = JSON.parse(sender.demoBalances || '{}');
      if ((senderBal[coinSymbol] || 0) < amt) {
        return res.status(400).json({ error: `Insufficient ${coinSymbol} balance` });
      }
      const receiverBal = JSON.parse(receiver.demoBalances || '{}');
      senderBal[coinSymbol] = (senderBal[coinSymbol] || 0) - amt;
      receiverBal[coinSymbol] = (receiverBal[coinSymbol] || 0) + amt;
      await Promise.all([
        prisma.user.update({ where: { id: sender.id }, data: { demoBalances: JSON.stringify(senderBal) } }),
        prisma.user.update({ where: { id: receiver.id }, data: { demoBalances: JSON.stringify(receiverBal) } })
      ]);
    }

    const fakeTxHash = '0x' + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    const message = await prisma.message.create({
      data: {
        fromUsername: req.user.username,
        toUsername: toUsername.toLowerCase(),
        text: note || null,
        amount: amt,
        currency: coinSymbol,
        txHash: fakeTxHash,
        type: 'PAYMENT',
        status: 'CONFIRMED'
      }
    });

    io.to(toUsername.toLowerCase()).emit('new_message', message);
    io.to(toUsername.toLowerCase()).emit('payment_received', {
      from: req.user.username,
      amount: amt,
      currency: coinSymbol,
      message
    });

    res.json({ success: true, message, txHash: fakeTxHash });
  } catch (err) {
    console.error('Send error:', err);
    res.status(500).json({ error: 'Transfer failed' });
  }
});

// POST /wallet/viral-link
router.post('/viral-link', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  const { amount, currency, coin, note } = req.body;
  const coinSymbol = (currency || coin || '').toUpperCase();

  if (!amount || !coinSymbol) return res.status(400).json({ error: 'amount and currency required' });

  try {
    const amt = parseFloat(amount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    if (process.env.DEMO_MODE === 'true') {
      const sender = await prisma.user.findUnique({ where: { id: req.user.id } });
      const bal = JSON.parse(sender.demoBalances || '{}');
      if ((bal[coinSymbol] || 0) < amt) {
        return res.status(400).json({ error: `Insufficient ${coinSymbol} balance` });
      }
      bal[coinSymbol] -= amt;
      await prisma.user.update({ where: { id: req.user.id }, data: { demoBalances: JSON.stringify(bal) } });
    }

    const claimToken = uuidv4().replace(/-/g, '');
    const message = await prisma.message.create({
      data: {
        fromUsername: req.user.username,
        toUsername: 'pending',
        text: note || null,
        amount: amt,
        currency: coinSymbol,
        type: 'PAYMENT',
        status: 'SENT',
        claimToken
      }
    });

    const appUrl = process.env.FRONTEND_URL || 'https://kryptox.app';
    res.json({ claimLink: `${appUrl}/claim/${claimToken}`, claimToken, message });
  } catch (err) {
    console.error('Viral link error:', err);
    res.status(500).json({ error: 'Failed to create viral link' });
  }
});

// GET /wallet/claim/:token
router.get('/claim/:token', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const message = await prisma.message.findUnique({ where: { claimToken: req.params.token } });
    if (!message) return res.status(404).json({ error: 'Claim link not found or expired' });
    if (message.status === 'CLAIMED') return res.status(410).json({ error: 'Already claimed' });

    const sender = await prisma.user.findFirst({
      where: { username: message.fromUsername },
      select: { username: true, avatar: true }
    });

    res.json({
      from: sender,
      amount: message.amount,
      currency: message.currency,
      note: message.text,
      createdAt: message.createdAt,
      token: req.params.token
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get claim info' });
  }
});

// POST /wallet/claim/:token
router.post('/claim/:token', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  const io = req.app.get('io');
  try {
    const message = await prisma.message.findUnique({ where: { claimToken: req.params.token } });
    if (!message || message.status !== 'SENT') {
      return res.status(400).json({ error: 'Invalid or already claimed link' });
    }
    if (message.fromUsername === req.user.username) {
      return res.status(400).json({ error: 'Cannot claim your own link' });
    }

    if (process.env.DEMO_MODE === 'true') {
      const claimer = await prisma.user.findUnique({ where: { id: req.user.id } });
      const bal = JSON.parse(claimer.demoBalances || '{}');
      bal[message.currency] = (bal[message.currency] || 0) + message.amount;
      await prisma.user.update({ where: { id: req.user.id }, data: { demoBalances: JSON.stringify(bal) } });
    }

    await prisma.message.update({
      where: { id: message.id },
      data: { toUsername: req.user.username, status: 'CLAIMED' }
    });

    io.to(message.fromUsername).emit('claim_received', {
      claimer: req.user.username,
      amount: message.amount,
      currency: message.currency
    });

    res.json({ success: true, amount: message.amount, currency: message.currency });
  } catch (err) {
    console.error('Claim error:', err);
    res.status(500).json({ error: 'Failed to claim' });
  }
});

// POST /wallet/swap
router.post('/swap', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  const { fromCoin, toCoin, fromAmount } = req.body;
  if (!fromCoin || !toCoin || !fromAmount) {
    return res.status(400).json({ error: 'fromCoin, toCoin, fromAmount required' });
  }
  try {
    const amt = parseFloat(fromAmount);
    if (isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid amount' });

    const prices = await getPriceMap(prisma);
    const fromPrice = prices[fromCoin.toUpperCase()]?.price || FALLBACK_PRICES[fromCoin.toUpperCase()] || 1;
    const toPrice = prices[toCoin.toUpperCase()]?.price || FALLBACK_PRICES[toCoin.toUpperCase()] || 1;
    const toAmount = (amt * fromPrice / toPrice) * 0.997;

    if (process.env.DEMO_MODE === 'true') {
      const user = await prisma.user.findUnique({ where: { id: req.user.id } });
      const bal = JSON.parse(user.demoBalances || '{}');
      const from = fromCoin.toUpperCase();
      const to = toCoin.toUpperCase();
      if ((bal[from] || 0) < amt) {
        return res.status(400).json({ error: `Insufficient ${from} balance` });
      }
      bal[from] = (bal[from] || 0) - amt;
      bal[to] = (bal[to] || 0) + toAmount;
      await prisma.user.update({ where: { id: req.user.id }, data: { demoBalances: JSON.stringify(bal) } });
    }

    res.json({
      success: true,
      fromAmount: amt,
      fromCoin: fromCoin.toUpperCase(),
      toAmount,
      toCoin: toCoin.toUpperCase(),
      rate: fromPrice / toPrice,
      fee: amt * fromPrice * 0.003
    });
  } catch (err) {
    console.error('Swap error:', err);
    res.status(500).json({ error: 'Swap failed' });
  }
});

// GET /wallet/prices
router.get('/prices', async (req, res) => {
  const prisma = req.app.get('prisma');
  res.json(await getPriceMap(prisma));
});

module.exports = router;
