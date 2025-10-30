const crypto = require('crypto');

const API_KEY = process.env.COINBASE_COMMERCE_API_KEY;
const API_VERSION = '2018-03-22';
const WEBHOOK_SECRET = process.env.COINBASE_COMMERCE_WEBHOOK_SECRET;
const API_BASE = 'https://api.commerce.coinbase.com';

function assertConfigured() {
  if (!API_KEY) throw new Error('COINBASE_COMMERCE_API_KEY missing');
}

async function createCharge({ name, description, amountUsd, metadata }) {
  assertConfigured();
  const body = {
    name,
    description,
    pricing_type: 'fixed_price',
    local_price: { amount: Number(amountUsd).toFixed(2), currency: 'USD' },
    metadata: metadata || {},
  };
  const res = await fetch(`${API_BASE}/charges`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CC-Api-Key': API_KEY,
      'X-CC-Version': API_VERSION,
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = data.error?.message || res.statusText;
    throw new Error(`Coinbase createCharge failed: ${msg}`);
  }
  return data.data; // has id, hosted_url
}

function verifyWebhookSignature(rawBody, signature) {
  if (!WEBHOOK_SECRET) throw new Error('COINBASE_COMMERCE_WEBHOOK_SECRET missing');
  const computed = crypto.createHmac('sha256', WEBHOOK_SECRET).update(rawBody, 'utf8').digest('hex');
  return crypto.timingSafeEqual(Buffer.from(computed, 'hex'), Buffer.from(signature, 'hex'));
}

module.exports = { createCharge, verifyWebhookSignature };

