const crypto = require('crypto');

const API_TOKEN = process.env.CRYPTOPAY_API_TOKEN || '';
const API_BASE = 'https://pay.crypt.bot/api';

function isConfigured() {
  return !!API_TOKEN;
}

async function cpFetch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Crypto-Pay-API-Token': API_TOKEN,
    },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const msg = data?.error?.message || res.statusText;
    throw new Error(`CryptoPay API error: ${msg}`);
  }
  return data.result;
}

async function createInvoice({ amount, asset = 'USDT', description, payload, expires_in = 3600 }) {
  if (!isConfigured()) throw new Error('CRYPTOPAY_API_TOKEN missing');
  const result = await cpFetch('/createInvoice', {
    asset,
    amount: Number(amount),
    description: description || 'Sticker pack',
    payload: String(payload || ''),
    expires_in,
    allow_comments: false,
    allow_anonymous: false,
  });
  // normalize URL field
  if (result && !result.invoice_url && result.pay_url) {
    result.invoice_url = result.pay_url;
  }
  // result contains invoice_url|pay_url, invoice_id, status
  return result;
}

function verifyWebhookSignature(rawBody, headerValue) {
  if (!isConfigured()) throw new Error('CRYPTOPAY_API_TOKEN missing');
  if (!headerValue) return false;
  const h = crypto.createHmac('sha256', API_TOKEN).update(rawBody, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(String(headerValue), 'hex'));
  } catch (_) {
    return false;
  }
}

module.exports = { isConfigured, createInvoice, verifyWebhookSignature };
