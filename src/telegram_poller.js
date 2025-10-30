const { query } = require('./db');
const { parseChatTarget, sendTelegramMessage } = require('./telegram');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

async function telegramApi(method, payload) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = data.description || res.statusText;
    throw new Error(`Telegram API ${method} error: ${err}`);
  }
  return data.result;
}

async function handleUpdate(upd) {
  const msg = upd.message || upd.edited_message || upd.channel_post || upd.edited_channel_post;
  if (!msg || !msg.chat) return;
  const chatId = String(msg.chat.id);
  const username = (msg.from && msg.from.username) ? String(msg.from.username) : null;
  const text = msg.text || msg.caption || '';

  // Store chat id by username if present
  if (username) {
    try {
      await query(`UPDATE users SET telegram_chat_id=$1 WHERE LOWER(username)=LOWER($2) AND (telegram_chat_id IS NULL OR telegram_chat_id<>$1)`, [chatId, username]);
    } catch (_) {}
    try {
      await query(`UPDATE orders SET buyer_chat_id=$1 WHERE buyer_chat_id IS NULL AND (LOWER(buyer_telegram)=LOWER($2) OR LOWER(buyer_telegram)=LOWER($3))`, [chatId, '@' + username, username]);
    } catch (_) {}
  }

  // Respond to /start and simple ack
  try {
    if (/^\/start\b/i.test(text)) {
      await sendTelegramMessage(chatId, `Chat linked ✅\nchat_id=${chatId}${username ? `\nusername=@${username}` : ''}`);
    } else if (/^\/id\b/i.test(text)) {
      await sendTelegramMessage(chatId, `Your chat_id is ${chatId}${username ? `\nusername=@${username}` : ''}`);
    }
  } catch (_) {}
}

async function startTelegramPoller() {
  if (!BOT_TOKEN) {
    console.warn('TELEGRAM_POLL=1 set but TELEGRAM_BOT_TOKEN missing');
    return;
  }
  let offset = 0;
  // Best effort reset webhook so polling works
  try { await telegramApi('deleteWebhook', { drop_pending_updates: false }); } catch (_) {}
  // Background loop
  (async function loop() {
    for (;;) {
      try {
        const updates = await telegramApi('getUpdates', { timeout: 50, offset: offset + 1 });
        for (const u of updates) {
          offset = Math.max(offset, u.update_id || 0);
          await handleUpdate(u);
        }
      } catch (e) {
        // small delay on error
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  })();
}

module.exports = { startTelegramPoller };

