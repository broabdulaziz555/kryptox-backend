require('dotenv').config();
const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const cors   = require('cors');
const { PrismaClient } = require('@prisma/client');

const app    = express();
const server = http.createServer(app);
const prisma = new PrismaClient();

// ── CORS ─────────────────────────────────────────────────────────────────────
//
//  Allowed origins:
//    Web / Vercel
//      • process.env.FRONTEND_URL      → your exact Vercel URL
//      • *.vercel.app                   → all Vercel preview deployments
//      • localhost / 127.0.0.1          → local development
//
//    Capacitor APK  (the origins Capacitor sends from Android / iOS WebViews)
//      • capacitor://localhost          → Capacitor iOS scheme
//      • http://localhost               → Capacitor Android WebView (default)
//      • https://localhost              → Capacitor when androidScheme='https'
//      • ionic://localhost              → Ionic / older Capacitor compatibility
//
//    No origin at all (null)            → server-to-server, curl, Postman

const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const isAllowed = (origin) => {
  if (!origin) return true;                                        // no origin → allow
  if (origin === process.env.FRONTEND_URL)           return true; // exact Vercel URL
  if (EXTRA_ORIGINS.includes(origin))               return true; // any extra from env
  if (/https?:\/\/.*\.vercel\.app$/.test(origin))   return true; // *.vercel.app previews
  if (/https?:\/\/localhost(:\d+)?$/.test(origin))  return true; // localhost (any port)
  if (/https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin)) return true; // 127.0.0.1
  if (origin === 'capacitor://localhost')            return true; // Capacitor iOS
  if (origin === 'ionic://localhost')                return true; // Ionic compat
  return false;
};

const allowedOrigin = (origin, callback) => {
  if (isAllowed(origin)) {
    callback(null, true);
  } else {
    console.warn(`CORS blocked origin: ${origin}`);
    callback(new Error(`Origin ${origin} not allowed`));
  }
};

const corsOptions = {
  origin:      allowedOrigin,
  credentials: true,
  methods:     ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};

// ── Socket.io ─────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: {
    origin:      allowedOrigin,
    methods:     ['GET', 'POST'],
    credentials: true,
  },
  transports: ['polling', 'websocket'],  // polling first for better proxy compat
  pingTimeout:  60000,
  pingInterval: 25000,
});

// ── Express middleware ────────────────────────────────────────────────────────
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));          // preflight for all routes
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);                    // trust Railway / Vercel proxy
app.set('io', io);
app.set('prisma', prisma);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/auth',    require('./routes/auth'));
app.use('/users',   require('./routes/users'));
app.use('/chat',    require('./routes/chat'));
app.use('/wallet',  require('./routes/wallet'));
app.use('/invoice', require('./routes/invoice'));
app.use('/auction', require('./routes/auction'));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    status:    'ok',
    demo:      process.env.DEMO_MODE === 'true',
    version:   '1.0.0',
    timestamp: new Date().toISOString(),
    uptime:    Math.floor(process.uptime()),
  });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).json({ error: `${req.method} ${req.path} not found` });
});

// ── Global error handler ──────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.message?.startsWith('Origin')) {
    return res.status(403).json({ error: err.message });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ── Socket handler ────────────────────────────────────────────────────────────
require('./socket/chat')(io, prisma);

// ── Blockchain detector ───────────────────────────────────────────────────────
if (process.env.DEMO_MODE !== 'true' && process.env.ALCHEMY_WEBSOCKET_URL) {
  require('./blockchain/detector')(io, prisma);
}

// ── Price updater ─────────────────────────────────────────────────────────────
require('./jobs/priceUpdater')(prisma);

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚀  KRYPTOX API  →  http://0.0.0.0:${PORT}`);
  console.log(`🗄️   Demo mode   →  ${process.env.DEMO_MODE === 'true' ? 'ON (fake balances)' : 'OFF (real blockchain)'}`);
  console.log(`🌐  Frontend     →  ${process.env.FRONTEND_URL || '(not set — set FRONTEND_URL)'}`);
  console.log(`📱  Capacitor    →  capacitor://localhost + http://localhost allowed\n`);
});

// ── Auto-seed if database is empty (runs once on first deploy) ───────────────
const autoSeed = async () => {
  try {
    const count = await prisma.user.count();
    if (count === 0) {
      console.log('🌱 Empty database — running seed...');
      const seed = require('./seed');
      await (typeof seed === 'function' ? seed(prisma) : seed.default?.(prisma) || seed.run?.(prisma));
      console.log('✅ Auto-seed complete');
    } else {
      console.log(`ℹ️  Database has ${count} users — skipping seed`);
    }
  } catch (e) {
    console.log('⚠️  Auto-seed skipped:', e.message);
  }
};
autoSeed();

// ── Graceful shutdown (Railway sends SIGTERM before stopping) ─────────────────
const shutdown = async (signal) => {
  console.log(`\nReceived ${signal} — shutting down gracefully…`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
  setTimeout(() => { console.error('Forced exit after 10s'); process.exit(1); }, 10_000);
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
