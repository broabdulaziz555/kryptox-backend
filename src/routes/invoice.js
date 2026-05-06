const express = require('express');
const router = express.Router();
const authMiddleware = require('../middleware/auth');

function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  const seq = Math.floor(Math.random() * 9000 + 1000).toString();
  return `INV-${year}-${seq}`;
}

// POST /invoice/create
router.post('/create', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  const { amount, currency, description, expiresInHours = 24 } = req.body;
  if (!amount || !description) return res.status(400).json({ error: 'amount and description required' });
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.id } });
    if (!user.isBusiness) return res.status(403).json({ error: 'Only business accounts can create invoices.' });

    const expiresAt = new Date(Date.now() + expiresInHours * 3600000);
    let invoiceNumber = generateInvoiceNumber();
    while (await prisma.invoice.findUnique({ where: { invoiceNumber } })) {
      invoiceNumber = generateInvoiceNumber();
    }

    const invoice = await prisma.invoice.create({
      data: {
        businessUsername: req.user.username,
        amount: parseFloat(amount),
        currency: (currency || 'USDT').toUpperCase(),
        description,
        invoiceNumber,
        expiresAt
      }
    });
    res.status(201).json({ invoice });
  } catch (err) {
    console.error('Create invoice error:', err);
    res.status(500).json({ error: 'Failed to create invoice' });
  }
});

// ─── STATIC ROUTES FIRST (must precede /:id wildcard) ────────────────────────

// GET /invoice/business/all (authenticated) — MUST be before /:id
router.get('/business/all', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  const { status } = req.query;
  try {
    const invoices = await prisma.invoice.findMany({
      where: {
        businessUsername: req.user.username,
        ...(status && { status })
      },
      orderBy: { createdAt: 'desc' }
    });
    res.json({ invoices });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get invoices' });
  }
});

// ─── DYNAMIC ROUTES ───────────────────────────────────────────────────────────

// GET /invoice/:id (public)
router.get('/:id', async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    let invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Auto-expire
    if (invoice.status === 'PENDING' && new Date() > invoice.expiresAt) {
      invoice = await prisma.invoice.update({
        where: { id: invoice.id },
        data: { status: 'EXPIRED' }
      });
    }

    const business = await prisma.user.findUnique({
      where: { username: invoice.businessUsername },
      select: { username: true, avatar: true, isVerified: true, bio: true }
    });

    res.json({ invoice: { ...invoice, business } });
  } catch (err) {
    res.status(500).json({ error: 'Failed to get invoice' });
  }
});

// POST /invoice/:id/pay
router.post('/:id/pay', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  const io = req.app.get('io');
  try {
    let invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'PENDING') return res.status(400).json({ error: `Invoice is ${invoice.status.toLowerCase()}` });
    if (new Date() > invoice.expiresAt) {
      await prisma.invoice.update({ where: { id: invoice.id }, data: { status: 'EXPIRED' } });
      return res.status(400).json({ error: 'Invoice has expired' });
    }
    if (invoice.businessUsername === req.user.username) {
      return res.status(400).json({ error: 'You cannot pay your own invoice' });
    }

    if (process.env.DEMO_MODE === 'true') {
      const [payer, business] = await Promise.all([
        prisma.user.findUnique({ where: { id: req.user.id } }),
        prisma.user.findUnique({ where: { username: invoice.businessUsername } })
      ]);
      const payerBal = JSON.parse(payer.demoBalances || '{}');
      const bizBal = JSON.parse(business?.demoBalances || '{}');
      const coin = invoice.currency;
      if ((payerBal[coin] || 0) < invoice.amount) {
        return res.status(400).json({ error: `Insufficient ${coin} balance` });
      }
      payerBal[coin] -= invoice.amount;
      bizBal[coin] = (bizBal[coin] || 0) + invoice.amount;
      await prisma.user.update({ where: { id: payer.id }, data: { demoBalances: JSON.stringify(payerBal) } });
      if (business) {
        await prisma.user.update({ where: { username: invoice.businessUsername }, data: { demoBalances: JSON.stringify(bizBal) } });
      }
    }

    const fakeTxHash = '0x' + [...Array(64)].map(() => Math.floor(Math.random() * 16).toString(16)).join('');
    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: 'PAID', paidByUsername: req.user.username, paidAt: new Date(), txHash: fakeTxHash }
    });

    io.to(invoice.businessUsername).emit('invoice_paid', updated);
    res.json({ success: true, invoice: updated, txHash: fakeTxHash });
  } catch (err) {
    console.error('Pay invoice error:', err);
    res.status(500).json({ error: 'Payment failed' });
  }
});

// PUT /invoice/:id/cancel
router.put('/:id/cancel', authMiddleware, async (req, res) => {
  const prisma = req.app.get('prisma');
  try {
    const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
    if (!invoice) return res.status(404).json({ error: 'Not found' });
    if (invoice.businessUsername !== req.user.username) return res.status(403).json({ error: 'Not authorized' });
    if (invoice.status !== 'PENDING') return res.status(400).json({ error: 'Can only cancel pending invoices' });
    const updated = await prisma.invoice.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } });
    res.json({ invoice: updated });
  } catch (err) {
    res.status(500).json({ error: 'Failed to cancel invoice' });
  }
});

module.exports = router;
