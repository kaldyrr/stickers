const path = require('path');
const fs = require('fs');
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
dotenv.config();

const { pool, initDb, getUserById, getUserByUsername, createAdminIfMissing, query } = require('./src/db');
const { sendOrderPaidNotification, parseChatTarget, sendTelegramMessage } = require('./src/telegram');
let startTelegramPoller;
try { ({ startTelegramPoller } = require('./src/telegram_poller')); } catch (_) {}
const { createCharge, verifyWebhookSignature } = require('./src/payments/coinbase');
const crypto = require('crypto');
const { getEvmConfig, verifyErc20Payment, amountUnitsFromCents } = require('./src/payments/evm');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'public')));

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev_secret',
    resave: false,
    saveUninitialized: false,
  })
);

app.use(async (req, res, next) => {
  res.locals.currentUser = null;
  if (req.session.userId) {
    try {
      const user = await getUserById(req.session.userId);
      if (user) {
        res.locals.currentUser = { id: user.id, username: user.username, is_admin: user.is_admin };
      }
    } catch (_) {}
  }
  next();
});

app.get('/healthz', (req, res) => {
  res.json({ ok: true });
});

function ensureAuth(req, res, next) {
  if (!req.session.userId) return res.redirect('/login');
  next();
}

function ensureAdmin(req, res, next) {
  if (!req.session.userId) return res.redirect('/admin/login');
  getUserById(req.session.userId)
    .then((u) => {
      if (!u || !u.is_admin) return res.redirect('/');
      next();
    })
    .catch(() => res.redirect('/'));
}

app.get('/', async (req, res) => {
  const packs = await query('SELECT * FROM sticker_packs ORDER BY created_at DESC');
  res.render('index', { packs: packs.rows });
});

app.get('/packs/:id', async (req, res) => {
  const id = Number(req.params.id);
  const pack = await query('SELECT * FROM sticker_packs WHERE id=$1', [id]);
  if (pack.rowCount === 0) return res.status(404).send('Not found');
  res.render('pack', { pack: pack.rows[0] });
});

app.post('/buy', async (req, res) => {
  const { pack_id, buyer_email, buyer_telegram } = req.body;
  const p = await query('SELECT * FROM sticker_packs WHERE id=$1', [pack_id]);
  if (p.rowCount === 0) return res.status(400).send('Invalid pack');
  const pack = p.rows[0];
  const userId = req.session.userId || null;
  const o = await query(
    `INSERT INTO orders (user_id, sticker_pack_id, price_cents, buyer_email, buyer_telegram, status)
     VALUES ($1,$2,$3,$4,$5,'pending') RETURNING id`,
    [userId, pack_id, pack.price_cents, buyer_email || null, buyer_telegram || null]
  );
  const orderId = o.rows[0].id;
  try {
    if (process.env.COINBASE_COMMERCE_API_KEY) {
      const charge = await createCharge({
        name: pack.name,
        description: pack.description?.slice(0, 120) || 'Sticker pack',
        amountUsd: pack.price_cents / 100,
        metadata: { order_id: orderId },
      });
      await query('UPDATE orders SET payment_provider=$1, provider_charge_id=$2, provider_hosted_url=$3, provider_status=$4 WHERE id=$5', [
        'coinbase', charge.id, charge.hosted_url, charge.timeline?.[charge.timeline.length - 1]?.status || 'created', orderId,
      ]);
      return res.redirect(charge.hosted_url);
    }
  } catch (e) {
    console.error('Failed to create payment', e.message || e);
  }
  res.redirect(`/order/${orderId}`);
});

app.get('/order/:id', async (req, res) => {
  const id = Number(req.params.id);
  const o = await query(
    `SELECT o.*, p.name AS pack_name, p.image_url AS pack_image_url, p.pack_url AS pack_url
     FROM orders o JOIN sticker_packs p ON p.id = o.sticker_pack_id WHERE o.id=$1`,
    [id]
  );
  if (o.rowCount === 0) return res.status(404).send('Not found');
  const evmCfg = getEvmConfig();
  res.render('order', { order: o.rows[0], evmEnabled: evmCfg.enabled, evmCfg });
});

// Resume or start payment from order page
app.get('/order/:id/pay', async (req, res) => {
  const id = Number(req.params.id);
  const o = await query('SELECT o.*, p.name, p.description, p.price_cents FROM orders o JOIN sticker_packs p ON p.id=o.sticker_pack_id WHERE o.id=$1', [id]);
  if (!o.rowCount) return res.status(404).send('Not found');
  const order = o.rows[0];
  if (order.provider_hosted_url) return res.redirect(order.provider_hosted_url);
  try {
    if (!process.env.COINBASE_COMMERCE_API_KEY) return res.redirect(`/order/${id}`);
    const charge = await createCharge({
      name: order.name,
      description: (order.description || '').slice(0, 120),
      amountUsd: order.price_cents / 100,
      metadata: { order_id: id },
    });
    await query('UPDATE orders SET payment_provider=$1, provider_charge_id=$2, provider_hosted_url=$3, provider_status=$4 WHERE id=$5', [
      'coinbase', charge.id, charge.hosted_url, charge.timeline?.[charge.timeline.length - 1]?.status || 'created', id,
    ]);
    return res.redirect(charge.hosted_url);
  } catch (e) {
    return res.redirect(`/order/${id}`);
  }
});

// Coinbase Commerce webhook
app.post('/webhooks/coinbase', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['x-cc-webhook-signature'];
  const raw = req.body instanceof Buffer ? req.body.toString('utf8') : req.body;
  try {
    if (!sig || !verifyWebhookSignature(raw, sig)) {
      return res.status(400).send('invalid signature');
    }
  } catch (e) {
    return res.status(400).send('verification error');
  }
  let payload;
  try { payload = JSON.parse(raw); } catch (_) { return res.status(400).send('bad json'); }
  const ev = payload?.event;
  const data = ev?.data;
  const chargeId = data?.id;
  const status = data?.timeline?.[data.timeline.length - 1]?.status || 'unknown';
  const orderId = data?.metadata?.order_id ? Number(data.metadata.order_id) : null;
  if (!orderId) return res.status(200).send('ok');
  try {
    await query('UPDATE orders SET provider_status=$1, provider_charge_id=$2, provider_hosted_url=$3, updated_at=NOW() WHERE id=$4', [
      status, chargeId || null, data?.hosted_url || null, orderId,
    ]);
    if (ev?.type === 'charge:confirmed') {
      // Mark paid and deliver immediately
      await query('UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2', ['paid', orderId]);
      try {
        const full = await query(
          `SELECT o.*, p.name AS pack_name, p.pack_url AS pack_url, u.telegram_chat_id
           FROM orders o JOIN sticker_packs p ON p.id=o.sticker_pack_id LEFT JOIN users u ON u.id=o.user_id WHERE o.id=$1`,
          [orderId]
        );
        if (full.rowCount) await sendOrderPaidNotification(full.rows[0]);
      } catch (_) {}
    }
  } catch (e) {
    // swallow
  }
  res.status(200).send('ok');
});

// EVM config for client
app.get('/evm/config', (req, res) => {
  const cfg = getEvmConfig();
  if (!cfg.enabled) return res.status(400).json({ enabled: false });
  res.json({
    enabled: true,
    chainId: cfg.chainId,
    tokenAddress: cfg.tokenAddress,
    tokenDecimals: cfg.tokenDecimals,
    merchant: cfg.merchant,
  });
});

// Verify EVM payment by tx hash
app.post('/order/:id/evm/verify', express.json(), async (req, res) => {
  const id = Number(req.params.id);
  const { txHash } = req.body || {};
  if (!txHash) return res.status(400).json({ ok: false, reason: 'missing txHash' });
  const r = await query('SELECT * FROM orders WHERE id=$1', [id]);
  if (!r.rowCount) return res.status(404).json({ ok: false, reason: 'order not found' });
  const order = r.rows[0];
  try {
    const vr = await verifyErc20Payment({ order, txHash });
    if (!vr.ok) return res.status(400).json(vr);
    await query('UPDATE orders SET status=$1, payment_provider=$2, provider_charge_id=$3, provider_status=$4, updated_at=NOW() WHERE id=$5', [
      'paid', 'evm', txHash, 'confirmed', id,
    ]);
    try {
      const full = await query(
        `SELECT o.*, p.name AS pack_name, p.pack_url AS pack_url, u.telegram_chat_id
         FROM orders o JOIN sticker_packs p ON p.id=o.sticker_pack_id LEFT JOIN users u ON u.id=o.user_id WHERE o.id=$1`,
        [id]
      );
      if (full.rowCount) await sendOrderPaidNotification(full.rows[0]);
    } catch (_) {}
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, reason: e.message || 'error' });
  }
});

app.get('/register', (req, res) => {
  if (req.session.userId) return res.redirect('/user');
  res.render('user/register', { error: null });
});

app.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !password) return res.render('user/register', { error: 'Username and password required' });
  const exists = await getUserByUsername(username);
  if (exists) return res.render('user/register', { error: 'Username already exists' });
  const hash = await bcrypt.hash(password, 10);
  await query('INSERT INTO users (username, email, password_hash, is_admin) VALUES ($1,$2,$3,false)', [
    username,
    email || null,
    hash,
  ]);
  const u = await getUserByUsername(username);
  req.session.userId = u.id;
  res.redirect('/user');
});

app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/user');
  res.render('user/login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await getUserByUsername(username);
  if (!user) return res.render('user/login', { error: 'Invalid credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render('user/login', { error: 'Invalid credentials' });
  req.session.userId = user.id;
  res.redirect('/user');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/user', ensureAuth, async (req, res) => {
  const orders = await query(
    `SELECT o.*, p.name AS pack_name FROM orders o
     JOIN sticker_packs p ON p.id = o.sticker_pack_id
     WHERE o.user_id=$1 ORDER BY o.created_at DESC`,
    [req.session.userId]
  );
  res.render('user/dashboard', { orders: orders.rows });
});

app.get('/admin/login', (req, res) => {
  if (req.session.userId) return res.redirect('/admin');
  res.render('admin/login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const user = await getUserByUsername(username);
  if (!user || !user.is_admin) return res.render('admin/login', { error: 'Invalid admin credentials' });
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.render('admin/login', { error: 'Invalid admin credentials' });
  req.session.userId = user.id;
  res.redirect('/admin');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/'));
});

app.get('/admin', ensureAdmin, async (req, res) => {
  const [{ rows: pc }, { rows: oc }] = await Promise.all([
    query('SELECT COUNT(*)::int AS count FROM sticker_packs'),
    query('SELECT COUNT(*)::int AS count FROM orders'),
  ]);
  res.render('admin/dashboard', {
    packCount: pc[0].count,
    orderCount: oc[0].count,
    defaultChat: process.env.TELEGRAM_DEFAULT_CHAT_ID || '',
  });
});

app.get('/admin/packs', ensureAdmin, async (req, res) => {
  const packs = await query('SELECT * FROM sticker_packs ORDER BY created_at DESC');
  res.render('admin/packs', { packs: packs.rows });
});

app.get('/admin/packs/new', ensureAdmin, (req, res) => {
  res.render('admin/packs_form', { pack: null, error: null });
});

app.post('/admin/packs/new', ensureAdmin, async (req, res) => {
  const { name, description, price_cents, image_url, pack_url } = req.body;
  if (!name || !price_cents) return res.render('admin/packs_form', { pack: null, error: 'Name and price are required' });
  await query(
    `INSERT INTO sticker_packs (name, description, price_cents, image_url, pack_url)
     VALUES ($1,$2,$3,$4,$5)`,
    [name, description || '', Number(price_cents), image_url || '', pack_url || '']
  );
  res.redirect('/admin/packs');
});

app.get('/admin/packs/:id/edit', ensureAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const p = await query('SELECT * FROM sticker_packs WHERE id=$1', [id]);
  if (p.rowCount === 0) return res.redirect('/admin/packs');
  res.render('admin/packs_form', { pack: p.rows[0], error: null });
});

app.post('/admin/packs/:id/edit', ensureAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { name, description, price_cents, image_url, pack_url } = req.body;
  await query(
    `UPDATE sticker_packs SET name=$1, description=$2, price_cents=$3, image_url=$4, pack_url=$5 WHERE id=$6`,
    [name, description || '', Number(price_cents), image_url || '', pack_url || '', id]
  );
  res.redirect('/admin/packs');
});

app.post('/admin/packs/:id/delete', ensureAdmin, async (req, res) => {
  const id = Number(req.params.id);
  await query('DELETE FROM sticker_packs WHERE id=$1', [id]);
  res.redirect('/admin/packs');
});

app.get('/admin/orders', ensureAdmin, async (req, res) => {
  const orders = await query(
    `SELECT o.*, p.name AS pack_name FROM orders o
     JOIN sticker_packs p ON p.id = o.sticker_pack_id
     ORDER BY o.created_at DESC`
  );
  res.render('admin/orders', { orders: orders.rows });
});

app.post('/admin/orders/:id/status', ensureAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body;
  const allowed = ['pending', 'paid', 'delivered', 'cancelled'];
  if (!allowed.includes(status)) return res.redirect('/admin/orders');
  await query('UPDATE orders SET status=$1, updated_at=NOW() WHERE id=$2', [status, id]);
  if (status === 'paid') {
    try {
      const o = await query(
        `SELECT o.*, p.name AS pack_name, p.pack_url AS pack_url, u.telegram_chat_id
         FROM orders o
         JOIN sticker_packs p ON p.id = o.sticker_pack_id
         LEFT JOIN users u ON u.id = o.user_id
         WHERE o.id=$1`,
        [id]
      );
      if (o.rowCount) {
        await sendOrderPaidNotification(o.rows[0]);
      }
    } catch (e) {
      console.error('Telegram notify failed:', e.message || e);
    }
  }
  res.redirect('/admin/orders');
});

// Lightweight admin endpoint to test Telegram send and parsing
app.get('/admin/telegram/test', ensureAdmin, async (req, res) => {
  const to = req.query.to || process.env.TELEGRAM_DEFAULT_CHAT_ID;
  const text = req.query.text || 'Hello from StickerShop!';
  if (!to) return res.status(400).send('Provide ?to=@username or numeric id or set TELEGRAM_DEFAULT_CHAT_ID');
  const parsed = parseChatTarget(to);
  try {
    await sendTelegramMessage(parsed.value, text);
    res.send(`Sent to ${parsed.type}:${parsed.value}`);
  } catch (e) {
    res.status(500).send(`Failed to send: ${e.message || e}`);
  }
});

// Admin logs tail endpoint
app.get('/admin/logs', ensureAdmin, (req, res) => {
  const tail = Math.min(parseInt(req.query.tail) || 200, 2000);
  const errLog = path.join(__dirname, 'server-error.log');
  let out = '';
  try {
    if (fs.existsSync(errLog)) {
      const data = fs.readFileSync(errLog, 'utf8');
      const lines = data.split(/\r?\n/);
      out = lines.slice(-tail).join('\n');
    } else {
      out = 'No error logs yet.';
    }
  } catch (e) {
    out = `Failed to read logs: ${e.message}`;
  }
  res.type('text/plain').send(out);
});

// Error handler to capture stack traces in a log file
app.use((err, req, res, next) => {
  try {
    fs.appendFileSync(path.join(__dirname, 'server-error.log'), `\n[${new Date().toISOString()}] ${req.method} ${req.url}\n${err.stack || err}\n`);
  } catch (_) {}
  res.status(500).send('Internal Server Error');
});

initDb()
  .then(createAdminIfMissing)
  .then(() => {
    if (startTelegramPoller && process.env.TELEGRAM_POLL === '1') {
      startTelegramPoller().catch((e) => console.error('Poller failed', e));
    }
    app.listen(PORT, () => console.log(`Server listening on :${PORT}`));
  })
  .catch((err) => {
    console.error('Failed to init DB', err);
    process.exit(1);
  });
