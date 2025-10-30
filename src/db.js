const { Pool } = require('pg');
const { newDb } = require('pg-mem');
const bcrypt = require('bcryptjs');

let pool;
let memDb = null;

const shouldUseMem = () => {
  const url = process.env.DATABASE_URL || '';
  return process.env.USE_PGMEM === '1' || /<.*>/.test(url);
};

function initPool() {
  if (shouldUseMem()) {
    memDb = newDb();
    const adapter = memDb.adapters.createPg();
    pool = new adapter.Pool();
    return;
  }
  pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/stickers',
    ssl: process.env.DATABASE_URL && !process.env.LOCAL_DEV ? { rejectUnauthorized: false } : false,
  });
}

initPool();

async function query(text, params) {
  return pool.query(text, params);
}

async function initDb() {
  await query(`CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    email TEXT,
    password_hash TEXT NOT NULL,
    is_admin BOOLEAN NOT NULL DEFAULT false,
    telegram_chat_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS sticker_packs (
    id SERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    image_url TEXT NOT NULL DEFAULT '',
    pack_url TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  await query(`CREATE TABLE IF NOT EXISTS orders (
    id SERIAL PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    sticker_pack_id INTEGER NOT NULL REFERENCES sticker_packs(id) ON DELETE CASCADE,
    price_cents INTEGER NOT NULL,
    buyer_email TEXT,
    buyer_telegram TEXT,
    buyer_chat_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);

  // Best-effort migrations for existing DBs
  try { await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_chat_id TEXT`); } catch (_) {}
  try { await query(`ALTER TABLE orders ADD COLUMN IF NOT EXISTS buyer_chat_id TEXT`); } catch (_) {}

  const packs = await query('SELECT COUNT(*)::int AS c FROM sticker_packs');
  if (packs.rows[0].c === 0) {
    await query(
      `INSERT INTO sticker_packs (name, description, price_cents, image_url, pack_url)
       VALUES 
       ('Cool Cats', 'Cute cat stickers to brighten chats.', 399, 'https://images.unsplash.com/photo-1592194996308-7b43878e84a6?w=800&q=80', 'https://t.me/addstickers/cool_cats'),
       ('Retro Vibes', 'Neon retro aesthetics, 80s vibes.', 499, 'https://images.unsplash.com/photo-1558981806-ec527fa84c39?w=800&q=80', 'https://t.me/addstickers/retro_vibes'),
       ('Meme Pack', 'Fresh memes for every mood.', 299, 'https://images.unsplash.com/photo-1520975922323-7ce3a0fd2b88?w=800&q=80', 'https://t.me/addstickers/meme_pack')`
    );
  }

  // Ensure requested cat packs exist (Komaru, Cocoa, Komugi)
  async function ensurePack(name, description, price_cents, image_url, pack_url) {
    await query(
      `INSERT INTO sticker_packs (name, description, price_cents, image_url, pack_url)
       SELECT $1, $2, CAST($3 AS integer), $4, $5
       WHERE NOT EXISTS (SELECT 1 FROM sticker_packs WHERE name = $1)`,
      [name, description, price_cents, image_url, pack_url]
    );
  }

  await ensurePack(
    'Komaru',
    'Adorable Komaru the cat — playful and expressive.',
    399,
    'https://images.unsplash.com/photo-1511044568932-338cba0ad803?w=800&q=80',
    'https://t.me/addstickers/komaru_cat'
  );
  await ensurePack(
    'Cocoa',
    'Sweet Cocoa the cuddly cat with cozy vibes.',
    399,
    'https://images.unsplash.com/photo-1519052537078-e6302a4968d4?w=800&q=80',
    'https://t.me/addstickers/cocoa_cat'
  );
  await ensurePack(
    'Komugi',
    'Komugi the curious kitten — tons of charm.',
    399,
    'https://images.unsplash.com/photo-1555685812-4b943f1cb0eb?w=800&q=80',
    'https://t.me/addstickers/komugi_cat'
  );
}

async function createAdminIfMissing() {
  const res = await query('SELECT id FROM users WHERE username=$1', ['admin']);
  if (res.rowCount === 0) {
    const password_hash = await bcrypt.hash('123', 10);
    await query('INSERT INTO users (username, email, password_hash, is_admin) VALUES ($1,$2,$3,true)', [
      'admin',
      'admin@example.com',
      password_hash,
    ]);
  }
}

async function getUserById(id) {
  const res = await query('SELECT * FROM users WHERE id=$1', [id]);
  return res.rowCount ? res.rows[0] : null;
}

async function getUserByUsername(username) {
  const res = await query('SELECT * FROM users WHERE username=$1', [username]);
  return res.rowCount ? res.rows[0] : null;
}

module.exports = { pool, query, initDb, createAdminIfMissing, getUserById, getUserByUsername };
