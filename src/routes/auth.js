const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { ethers } = require('ethers');
const nodemailer = require('nodemailer');

const RESERVED_USERNAMES = [
  'admin', 'support', 'official', 'help', 'kryptox', 'system',
  'bitcoin', 'ethereum', 'crypto', 'wallet', 'pay', 'send',
  'money', 'cash', 'gold', 'shop', 'store', 'bank', 'finance',
  'uz', 'ru', 'kz', 'en', 'tashkent', 'null', 'undefined',
  'root', 'api', 'www', 'mail', 'ftp', 'localhost'
];

function validateUsername(username) {
  if (!username || username.length < 3 || username.length > 20) {
    return 'Username must be 3-20 characters';
  }
  if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(username)) {
    return 'Username must start with a letter and contain only letters, numbers, underscores';
  }
  if (RESERVED_USERNAMES.includes(username.toLowerCase())) {
    return 'This username is reserved';
  }
  return null;
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, email: user.email },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

// POST /auth/register
router.post('/register', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'username, email, and password are required' });
  }

  const usernameError = validateUsername(username);
  if (usernameError) {
    return res.status(400).json({ error: usernameError });
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Invalid email address' });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }

  try {
    // Check existing user
    const existing = await prisma.user.findFirst({
      where: {
        OR: [
          { username: username.toLowerCase() },
          { email: email.toLowerCase() }
        ]
      }
    });

    if (existing) {
      if (existing.username === username.toLowerCase()) {
        return res.status(409).json({ error: 'Username already taken' });
      }
      return res.status(409).json({ error: 'Email already registered' });
    }

    // Generate Ethereum wallet
    const wallet = ethers.Wallet.createRandom();
    const publicAddress = wallet.address;
    const privateKey = wallet.privateKey;
    const mnemonic = wallet.mnemonic.phrase;

    // Hash password
    const passwordHash = await bcrypt.hash(password, 12);

    // Generate email verify code
    const emailVerifyCode = Math.floor(100000 + Math.random() * 900000).toString();

    // Create user
    const user = await prisma.user.create({
      data: {
        username: username.toLowerCase(),
        email: email.toLowerCase(),
        passwordHash,
        publicAddress,
        emailVerifyCode
      }
    });

    // Send verification email (non-blocking)
    sendVerificationEmail(email, emailVerifyCode, username).catch(console.error);

    const token = generateToken(user);

    res.status(201).json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        publicAddress: user.publicAddress,
        isEmailVerified: user.isEmailVerified
      },
      // One-time sensitive data - never stored on server
      wallet: {
        privateKey,
        mnemonic,
        warning: 'SAVE THIS! This is shown ONCE and never stored on our servers.'
      }
    });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /auth/login
router.post('/login', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { identifier, password } = req.body; // identifier = email or username

  if (!identifier || !password) {
    return res.status(400).json({ error: 'Email/username and password are required' });
  }

  try {
    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { email: identifier.toLowerCase() },
          { username: identifier.toLowerCase() }
        ]
      }
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const passwordMatch = await bcrypt.compare(password, user.passwordHash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user);

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        publicAddress: user.publicAddress,
        avatar: user.avatar,
        bio: user.bio,
        isBusiness: user.isBusiness,
        isVerified: user.isVerified,
        isPremium: user.isPremium,
        isEmailVerified: user.isEmailVerified,
        preferredLanguage: user.preferredLanguage
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed' });
  }
});

// POST /auth/verify-email
router.post('/verify-email', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { email, code } = req.body;

  try {
    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase() }
    });

    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.emailVerifyCode !== code) {
      return res.status(400).json({ error: 'Invalid verification code' });
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { isEmailVerified: true, emailVerifyCode: null }
    });

    res.json({ message: 'Email verified successfully' });
  } catch (err) {
    res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /auth/resend-code
router.post('/resend-code', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { email } = req.body;

  try {
    const user = await prisma.user.findFirst({
      where: { email: email.toLowerCase() }
    });
    if (!user) return res.status(404).json({ error: 'User not found' });

    const newCode = Math.floor(100000 + Math.random() * 900000).toString();
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerifyCode: newCode }
    });

    await sendVerificationEmail(email, newCode, user.username);
    res.json({ message: 'Verification code sent' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to resend code' });
  }
});

// POST /auth/check-username
router.post('/check-username', async (req, res) => {
  const prisma = req.app.get('prisma');
  const { username } = req.body;

  const error = validateUsername(username);
  if (error) return res.json({ available: false, reason: error });

  const existing = await prisma.user.findFirst({
    where: { username: username.toLowerCase() }
  });
  const reserved = await prisma.reservedUsername.findFirst({
    where: { username: username.toLowerCase() }
  });

  res.json({
    available: !existing && !reserved,
    reason: existing ? 'Already taken' : reserved ? 'Reserved username' : null
  });
});

async function sendVerificationEmail(email, code, username) {
  if (!process.env.GMAIL_USER) return; // Skip if not configured

  const transporter = nodemailer.createTransporter({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });

  await transporter.sendMail({
    from: `Kryptox <${process.env.EMAIL_FROM || process.env.GMAIL_USER}>`,
    to: email,
    subject: 'Verify your Kryptox account',
    html: `
      <div style="font-family:sans-serif;max-width:400px;margin:0 auto;background:#0A0A0F;color:white;padding:32px;border-radius:16px">
        <h2 style="color:#7B5EA7">Welcome to Kryptox, @${username}!</h2>
        <p>Your verification code is:</p>
        <div style="background:#1A1A26;border-radius:12px;padding:24px;text-align:center;font-size:36px;font-weight:bold;letter-spacing:8px;color:#F0B429">${code}</div>
        <p style="color:#8888AA;font-size:13px">This code expires in 10 minutes. If you didn't create this account, ignore this email.</p>
      </div>
    `
  });
}

module.exports = router;
