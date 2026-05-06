require('dotenv').config();
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const cors       = require('cors');
const helmet     = require('helmet');
const morgan     = require('morgan');
const rateLimit  = require('express-rate-limit');
const { PrismaClient } = require('@prisma/client');

const app    = express();
const server = http.createServer(app);
const prisma = new PrismaClient();

// ── CORS ──────────────────────────────────────────────────────────────────────
const EXTRA = (process.env.ALLOWED_ORIGINS || '').split(',').map(s=>s.trim()).filter(Boolean);
const isAllowed = (origin) => {
  if (!origin) return true;
  if (origin === process.env.FRONTEND_URL) return true;
  if (EXTRA.includes(origin)) return true;
  if (/https?:\/\/.*\.vercel\.app$/.test(origin)) return true;
  if (/https?:\/\/localhost(:\d+)?$/.test(origin)) return true;
  if (/https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true;
  if (origin === 'capacitor://localhost') return true;
  if (origin === 'ionic://localhost') return true;
  return false;
};
const allowedOrigin = (origin, cb) =>
  isAllowed(origin) ? cb(null, true) : cb(new Error(`CORS blocked: ${origin}`));

const corsOpts = {
  origin: allowedOrigin, credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization'],
};

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: allowedOrigin, methods: ['GET','POST'], credentials: true },
  transports: ['polling','websocket'],
  pingTimeout: 60000, pingInterval: 25000,
});

// ── Middleware ────────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan('combined'));
app.use(cors(corsOpts));
app.options('*', cors(corsOpts));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);
app.set('io', io);
app.set('prisma', prisma);

// ── Rate limiting ─────────────────────────────────────────────────────────────
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 100,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});
const authLimiter = rateLimit({
  windowMs: 60 * 1000, max: 5,
  message: { error: 'Too many auth attempts, please slow down.' },
});
app.use(globalLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth',    authLimiter, require('./routes/auth'));
app.use('/users',   require('./routes/users'));
app.use('/chat',    require('./routes/chat'));
app.use('/wallet',  require('./routes/wallet'));
app.use('/invoice', require('./routes/invoice'));
app.use('/auction', require('./routes/auction'));

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status: 'ok', demo: process.env.DEMO_MODE === 'true',
  version: '2.0.0', uptime: Math.floor(process.uptime()),
}));

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ error: `${req.method} ${req.path} not found` }));

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  if (err.message?.startsWith('CORS')) return res.status(403).json({ error: err.message });
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Socket ────────────────────────────────────────────────────────────────────
require('./socket/chat')(io, prisma);

// ── Blockchain + prices ───────────────────────────────────────────────────────
if (process.env.DEMO_MODE !== 'true' && process.env.ALCHEMY_WEBSOCKET_URL) {
  require('./blockchain/detector')(io, prisma);
}
require('./jobs/priceUpdater')(prisma);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀  KRYPTOX v2  →  port ${PORT}`);
  console.log(`🗄️   Demo mode  →  ${process.env.DEMO_MODE === 'true' ? 'ON' : 'OFF'}`);
  console.log(`🌐  Frontend   →  ${process.env.FRONTEND_URL || '(not set)'}\n`);
});

// ── Auto-seed ─────────────────────────────────────────────────────────────────
const autoSeed = async () => {
  try {
    const count = await prisma.user.count();
    if (count === 0) {
      console.log('🌱 Seeding database...');
      const seed = require('./seed');
      await (typeof seed === 'function' ? seed(prisma) : null);
      console.log('✅ Seed complete');
    }
  } catch (e) { console.log('⚠️  Seed skipped:', e.message); }
};
autoSeed();

// ── Graceful shutdown ─────────────────────────────────────────────────────────
const shutdown = async (sig) => {
  console.log(`\n${sig} received — shutting down`);
  server.close(async () => { await prisma.$disconnect(); process.exit(0); });
  setTimeout(() => process.exit(1), 10000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
