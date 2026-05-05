require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const { ethers } = require('ethers');

const prisma = new PrismaClient();

const RESERVED = [
  'admin', 'support', 'official', 'help', 'kryptox', 'system',
  'bitcoin', 'ethereum', 'crypto', 'wallet', 'pay', 'send',
  'money', 'cash', 'gold', 'shop', 'store', 'bank', 'finance',
  'uz', 'ru', 'kz', 'en', 'tashkent', 'null', 'undefined',
  'root', 'api', 'www', 'mail', 'ftp', 'localhost'
];

async function main() {
  console.log('🌱 Seeding Kryptox database...');

  // Seed reserved usernames
  for (const username of RESERVED) {
    await prisma.reservedUsername.upsert({
      where: { username },
      create: { username, reason: 'system' },
      update: {}
    });
  }
  console.log('✅ Reserved usernames seeded');

  // Seed premium auction usernames
  const premiumUsernames = ['pay', 'gold', 'uz', 'cash', 'earn', 'pro', 'vip', 'x', 'ai'];
  const auctionEnd = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days
  
  for (const username of premiumUsernames) {
    const startBid = username.length <= 2 ? 500 : username.length === 3 ? 200 : 50;
    await prisma.auction.upsert({
      where: { username },
      create: {
        username,
        startingBid: startBid,
        currentBid: startBid,
        endsAt: auctionEnd,
        status: 'ACTIVE'
      },
      update: {}
    });
  }
  console.log('✅ Auctions seeded');

  // Seed demo users
  const demoUsers = [
    {
      username: 'aziz',
      email: 'aziz@demo.com',
      password: 'demo1234',
      bio: 'Crypto enthusiast from Tashkent 🇺🇿',
      isBusiness: false,
      demoBalances: JSON.stringify({ USDT: 850, ETH: 0.42, BTC: 0.008, SOL: 12, BNB: 1.5 })
    },
    {
      username: 'kamol',
      email: 'kamol@demo.com',
      password: 'demo1234',
      bio: 'BTC hodler. DeFi explorer.',
      isBusiness: false,
      demoBalances: JSON.stringify({ USDT: 320, ETH: 0.18, BTC: 0.032, SOL: 8, TRX: 2500 })
    },
    {
      username: 'jasur',
      email: 'jasur@demo.com',
      password: 'demo1234',
      bio: 'Software developer, Samarkand',
      isBusiness: false,
      demoBalances: JSON.stringify({ USDT: 500, ETH: 0.25, SOL: 20, AVAX: 5 })
    },
    {
      username: 'techshop',
      email: 'techshop@demo.com',
      password: 'demo1234',
      bio: 'Official Kryptox demo store 🛒 | Electronics & Gadgets in Tashkent',
      isBusiness: true,
      demoBalances: JSON.stringify({ USDT: 5400, ETH: 1.2, BTC: 0.05 })
    },
    {
      username: 'cafebar',
      email: 'cafebar@demo.com',
      password: 'demo1234',
      bio: '☕ Specialty coffee + crypto payments. Chilonzor, Tashkent',
      isBusiness: true,
      demoBalances: JSON.stringify({ USDT: 890, BNB: 2.3 })
    }
  ];

  const createdUsers = {};
  for (const u of demoUsers) {
    const wallet = ethers.Wallet.createRandom();
    const passwordHash = await bcrypt.hash(u.password, 10);
    
    const user = await prisma.user.upsert({
      where: { username: u.username },
      create: {
        username: u.username,
        email: u.email,
        passwordHash,
        publicAddress: wallet.address,
        bio: u.bio,
        isBusiness: u.isBusiness,
        isVerified: u.isBusiness,
        isEmailVerified: true,
        demoBalances: u.demoBalances
      },
      update: { bio: u.bio, demoBalances: u.demoBalances }
    });
    createdUsers[u.username] = user;
    console.log(`✅ User @${u.username} seeded`);
  }

  // Seed demo messages between @aziz and @kamol
  const demoMessages = [
    { from: 'kamol', to: 'aziz', text: 'Yo, send me that 50 USDT for dinner last night', type: 'TEXT' },
    { from: 'aziz', to: 'kamol', text: null, amount: 50, currency: 'USDT', type: 'PAYMENT', status: 'CONFIRMED',
      txHash: '0x' + 'a'.repeat(64) },
    { from: 'kamol', to: 'aziz', text: 'Got it! Thanks bro 🙏', type: 'TEXT' },
    { from: 'aziz', to: 'kamol', text: 'Splitting the rent 3 ways', amount: 100, currency: 'USDT', type: 'REQUEST', status: 'SENT' },
    { from: 'kamol', to: 'aziz', text: 'Hey are you going to the meetup?', type: 'TEXT' },
    { from: 'aziz', to: 'kamol', text: 'Yeah! Sending gas money', amount: 0.005, currency: 'ETH', type: 'PAYMENT',
      status: 'CONFIRMED', txHash: '0x' + 'b'.repeat(64) }
  ];

  for (const m of demoMessages) {
    await prisma.message.create({
      data: {
        fromUsername: m.from,
        toUsername: m.to,
        text: m.text,
        amount: m.amount || null,
        currency: m.currency || null,
        txHash: m.txHash || null,
        type: m.type,
        status: m.status || 'CONFIRMED'
      }
    });
  }
  console.log('✅ Demo messages seeded');

  // Seed demo invoices for @techshop
  const invoiceData = [
    { desc: 'iPhone 15 Pro Max 256GB', amount: 1199, status: 'PAID', paid: 'aziz' },
    { desc: 'MacBook Air M3 + Accessories', amount: 1450, status: 'PAID', paid: 'kamol' },
    { desc: 'Sony WH-1000XM5 Headphones', amount: 349, status: 'PENDING', paid: null },
    { desc: 'Samsung Galaxy S24 Ultra', amount: 1299, status: 'EXPIRED', paid: null }
  ];

  for (let i = 0; i < invoiceData.length; i++) {
    const inv = invoiceData[i];
    const year = new Date().getFullYear();
    await prisma.invoice.create({
      data: {
        businessUsername: 'techshop',
        amount: inv.amount,
        currency: 'USDT',
        description: inv.desc,
        invoiceNumber: `INV-${year}-${String(i + 1).padStart(3, '0')}`,
        status: inv.status,
        paidByUsername: inv.paid,
        paidAt: inv.paid ? new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000) : null,
        txHash: inv.paid ? '0x' + 'c'.repeat(64) : null,
        expiresAt: inv.status === 'EXPIRED'
          ? new Date(Date.now() - 24 * 60 * 60 * 1000)
          : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
      }
    });
  }
  console.log('✅ Demo invoices seeded');

  // Seed initial price cache
  const INITIAL_PRICES = {
    BTC: { price: 65000, change: 2.4 },
    ETH: { price: 3200, change: 1.8 },
    USDT: { price: 1, change: 0.01 },
    USDC: { price: 1, change: 0.01 },
    BNB: { price: 580, change: -0.5 },
    SOL: { price: 145, change: 3.2 },
    TRX: { price: 0.12, change: -1.2 },
    TON: { price: 5.8, change: 4.1 },
    XRP: { price: 0.55, change: -0.8 },
    ADA: { price: 0.45, change: 1.1 },
    DOGE: { price: 0.16, change: 5.2 },
    AVAX: { price: 35, change: 2.7 },
    MATIC: { price: 0.85, change: -1.5 },
    DOT: { price: 7.2, change: 0.9 },
    LTC: { price: 85, change: 1.3 },
    LINK: { price: 14, change: 2.1 },
    UNI: { price: 8.5, change: -0.7 },
    ATOM: { price: 8, change: 1.6 },
    DAI: { price: 1, change: 0.02 }
  };

  for (const [symbol, data] of Object.entries(INITIAL_PRICES)) {
    await prisma.priceCache.upsert({
      where: { symbol },
      create: { symbol, priceUSD: data.price, change24h: data.change },
      update: {}
    });
  }
  console.log('✅ Price cache seeded');

  console.log('\n🎉 Seeding complete!');
  console.log('\nDemo accounts (password: demo1234):');
  console.log('  @aziz     → aziz@demo.com');
  console.log('  @kamol    → kamol@demo.com');
  console.log('  @jasur    → jasur@demo.com');
  console.log('  @techshop → techshop@demo.com (business)');
  console.log('  @cafebar  → cafebar@demo.com (business)');
}

// ── Run standalone: node src/seed.js
// ── Or called from index.js: require('./seed')(existingPrisma)
if (require.main === module) {
  main()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
}

// Export so index.js can call it with its own prisma instance
module.exports = async function(externalPrisma) {
  // If called externally, swap out the prisma instance
  if (externalPrisma) {
    // re-run main logic inline with external prisma
    const bcrypt2 = require('bcryptjs');
    const { ethers: eth2 } = require('ethers');
    const pw = await bcrypt2.hash('demo1234', 12);

    const demos = [
      { username:'aziz',     email:'aziz@demo.com',     isBusiness:false },
      { username:'kamol',    email:'kamol@demo.com',     isBusiness:false },
      { username:'jasur',    email:'jasur@demo.com',     isBusiness:false },
      { username:'techshop', email:'techshop@demo.com',  isBusiness:true  },
      { username:'cafebar',  email:'cafebar@demo.com',   isBusiness:true  },
    ];

    const startBalance = JSON.stringify({ USDT:100, ETH:0.05, BTC:0.001, SOL:2 });

    for (const d of demos) {
      const wallet = eth2.Wallet.createRandom();
      await externalPrisma.user.upsert({
        where:  { username: d.username },
        update: {},
        create: {
          username:       d.username,
          email:          d.email,
          passwordHash:   pw,
          publicAddress:  wallet.address,
          isBusiness:     d.isBusiness,
          isEmailVerified:true,
          demoBalances:   startBalance,
        },
      });
      console.log('  ✅ seeded @' + d.username);
    }

    // Seed a couple of auctions
    const auctions = [
      { username:'pay',  currentBid:500,  startingBid:100 },
      { username:'gold', currentBid:250,  startingBid:50  },
      { username:'uz',   currentBid:180,  startingBid:50  },
      { username:'ai',   currentBid:420,  startingBid:100 },
    ];
    const future = new Date(Date.now() + 7*24*3600*1000);
    for (const a of auctions) {
      await externalPrisma.auction.upsert({
        where:  { username: a.username },
        update: {},
        create: { ...a, bidCount:0, endsAt:future, status:'ACTIVE' },
      });
    }
    console.log('  ✅ seeded auctions');
  } else {
    await main();
  }
};
