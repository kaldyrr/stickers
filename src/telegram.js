const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const DEFAULT_CHAT = process.env.TELEGRAM_DEFAULT_CHAT_ID; // optional fallback (group/channel/user id)
const DEBUG = process.env.TELEGRAM_NOTIFY_DEBUG === '1';

function canNotify() {
  return !!BOT_TOKEN;
}

async function telegramApi(method, payload) {
  if (!canNotify()) throw new Error('Missing TELEGRAM_BOT_TOKEN');
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = data.description || res.statusText;
    throw new Error(`Telegram API ${method} error: ${err}`);
  }
  return data.result;
}

async function sendTelegramMessage(chatId, text) {
  if (!chatId) return { ok: false, reason: 'missing chatId' };
  await telegramApi('sendMessage', { chat_id: chatId, text });
  return { ok: true };
}

function parseChatTarget(input) {
  if (!input) return { type: 'none', value: null };
  const raw = String(input).trim();
  if (!raw) return { type: 'none', value: null };
  // tg://user?id=123456
  const tgUser = raw.match(/^tg:\/\/user\?id=(-?\d+)$/i);
  if (tgUser) return { type: 'id', value: tgUser[1] };
  // https://t.me/username or t.me/username
  const tme = raw.match(/^https?:\/\/t\.me\/(.+)$/i) || raw.match(/^t\.me\/(.+)$/i);
  if (tme) {
    const user = tme[1].split(/[?#/]/)[0];
    if (/^-?\d+$/.test(user)) return { type: 'id', value: user };
    return { type: 'at', value: '@' + user.replace(/^@/, '') };
  }
  // numeric id
  if (/^-?\d+$/.test(raw)) return { type: 'id', value: raw };
  // @username or username
  if (raw.startsWith('@')) return { type: 'at', value: raw };
  return { type: 'at', value: '@' + raw };
}

function mentionFrom(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  return s.startsWith('@') ? s : '@' + s;
}

async function sendOrderPaidNotification(order) {
  // Prefer stored numeric chat ids (best for DMs)
  const preferred = String(order.buyer_chat_id || order.telegram_chat_id || '').trim() || null;
  const parsed = preferred ? { type: 'id', value: preferred } : parseChatTarget(order.buyer_telegram);
  const mention = mentionFrom(order.buyer_telegram);
  const header = mention ? `Hi ${mention}!` : 'Hi!';
  const debugLine = DEBUG
    ? `\n[debug] parsed=${parsed.type}:${parsed.value ?? 'null'} from="${order.buyer_telegram ?? ''}"`
    : '';
  const text = `${header}\nYour order #${order.id} for "${order.pack_name}" is marked as PAID.` +
               `\nWe will deliver shortly. If not received, reply here.` +
               (order.pack_url ? `\nPack link: ${order.pack_url}` : '') +
               debugLine;

  try {
    if (parsed.value) {
      // If it's a username, bots cannot DM a user unless they started the bot.
      // Still try: works for groups/channels.
      await sendTelegramMessage(parsed.value, text);
      return true;
    }
  } catch (e) {
    if (!DEFAULT_CHAT) throw e;
  }

  if (DEFAULT_CHAT) {
    const alt = `Order #${order.id} for "${order.pack_name}" is PAID.` +
                (mention ? ` Buyer: ${mention}.` : '') +
                (DEBUG ? `\n[debug] parsed=${parsed.type}:${parsed.value ?? 'null'} from="${order.buyer_telegram ?? ''}"` : '');
    await sendTelegramMessage(DEFAULT_CHAT, alt);
    return true;
  }
  return false;
}

module.exports = { sendOrderPaidNotification, parseChatTarget, sendTelegramMessage };
