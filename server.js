const express  = require('express');
const cors     = require('cors');
const fetch    = require('node-fetch');
const { MongoClient } = require('mongodb');

const app = express();
app.use(express.json());
app.use(cors());

// ── CONFIG ────────────────────────────────────────────────
const TG_TOKEN  = process.env.TG_TOKEN  || '8725137325:AAF_86TXecpPKpasuvUI_G2qw6QHOWF3KS8';
const TG_CHAT   = process.env.TG_CHAT   || '8725137325';
const PORT      = process.env.PORT      || 3000;
const WEBHOOK   = process.env.WEBHOOK_URL;
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://volodymyrpitykh_db_user:MvhcX7uLKXAf4hHl@cluster0.hfz0uta.mongodb.net/?appName=Cluster0';

// ── MONGODB ───────────────────────────────────────────────
let db;
const client = new MongoClient(MONGO_URI, {
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 30000,
  connectTimeoutMS: 10000,
});

async function connectDB() {
  await client.connect();
  db = client.db('dzendzо');
  console.log('MongoDB connected');
  setInterval(async () => {
    try { await db.command({ ping: 1 }); }
    catch (e) {
      console.warn('Ping failed, reconnecting...', e.message);
      try { await client.connect(); db = client.db('dzendzо'); } catch {}
    }
  }, 4 * 60 * 1000);
}

function col() {
  if (!db) throw new Error('DB not connected');
  return db.collection('bookings');
}

async function nextBookingNum() {
  const last = await col().findOne({}, { sort: { num: -1 }, projection: { num: 1 } });
  return last && last.num ? last.num + 1 : 1;
}

// ── HELPERS ───────────────────────────────────────────────
function tgSend(payload) {
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(r => r.json());
}

function tgEdit(chat_id, message_id, text) {
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id, message_id, text, parse_mode: 'Markdown' })
  });
}

function fmt(d) {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
}

function guestsLine(adults, children) {
  let line = `${adults} дорослих`;
  if (children && children > 0) line += `, ${children} дітей`;
  return line;
}

// ── REGISTER WEBHOOK ──────────────────────────────────────
if (WEBHOOK) {
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/setWebhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: `${WEBHOOK}/tg-webhook` })
  }).then(r => r.json()).then(d => console.log('Webhook set:', d.description));
}

// ── SET BOT COMMANDS ──────────────────────────────────────
setTimeout(() => {
  fetch(`https://api.telegram.org/bot${TG_TOKEN}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands: [
        { command: 'list',   description: 'Показати всі активні бронювання' },
        { command: 'cancel', description: 'Скасувати — /cancel 5' },
        { command: 'help',   description: 'Допомога' }
      ]
    })
  }).catch(() => {});
}, 3000);

// ── ROUTES ────────────────────────────────────────────────
app.post('/booking', async (req, res) => {
  const { checkin, checkout, adults, children, jacuzzi, jacuzziDays, name, phone, notes, total } = req.body;

  if (!checkin || !checkout || !name || !phone)
    return res.status(400).json({ ok: false, error: 'Missing required fields' });

  const phoneClean = phone.replace(/[\s\-\(\)]/g, '');
  if (!/^\+?[0-9]{7,15}$/.test(phoneClean))
    return res.status(400).json({ ok: false, error: 'Invalid phone number' });

  const d1 = new Date(checkin), d2 = new Date(checkout);
  const nights = Math.round((d2 - d1) / 86400000);
  if (nights < 2)
    return res.status(400).json({ ok: false, error: 'Minimum 2 nights' });

  const conflict = await col().findOne({
    status: 'confirmed',
    checkin:  { $lt: checkout },
    checkout: { $gt: checkin }
  });
  if (conflict)
    return res.status(409).json({ ok: false, error: 'Dates already booked' });

  const num = await nextBookingNum();
  const tubDays = (jacuzziDays && jacuzziDays.length) || 0;
  const tubCost = tubDays === 0 ? 0 : 2500 + (tubDays - 1) * 1000;
  const jacLabel = tubDays === 0 ? 'Без чану'
    : tubDays === 1 ? '1 вечір — 2 500 грн'
    : tubDays + ' вечорів — 2 500 + ' + (tubDays-1) + ' × 1 000 = ' + tubCost.toLocaleString('uk-UA') + ' грн';

  await col().insertOne({
    num, checkin, checkout,
    adults: adults || 2, children: children || 0,
    jacuzzi, jacuzziDays: jacuzziDays || [], name, phone, notes, total,
    status: 'pending',
    createdAt: new Date().toISOString()
  });

  await tgSend({
    chat_id: TG_CHAT,
    text:
      `*🏔️ Нова заявка №${num} — Dzendz'o*\n\n` +
      `Імʼя: ${name}\n` +
      `Телефон: ${phone}\n` +
      `Заїзд: ${fmt(checkin)}\n` +
      `Виїзд: ${fmt(checkout)}\n` +
      `Ночей: ${nights}\n` +
      `Гостей: ${guestsLine(adults || 2, children || 0)}\n` +
      `Чан: ${jacLabel}\n` +
      (jacuzziDays && jacuzziDays.length ? `Вечори чану: ${jacuzziDays.map(d => { const [y,m,day]=d.split('-'); return day+'.'+m; }).join(', ')}\n` : '') +
      `Примітки: ${notes || '—'}\n` +
      `Сума: ₴ ${Number(total).toLocaleString('uk-UA')}`,
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Підтвердити',  callback_data: `confirm:${num}` },
        { text: '❌ Відхилити',    callback_data: `reject:${num}`  }
      ]]
    }
  });

  res.json({ ok: true, num });
});

app.get('/bookings', async (req, res) => {
  const confirmed = await col()
    .find({ status: 'confirmed' }, { projection: { checkin: 1, checkout: 1, _id: 0 } })
    .toArray();
  res.json(confirmed);
});

// ── TELEGRAM WEBHOOK ──────────────────────────────────────
app.post('/tg-webhook', async (req, res) => {
  res.sendStatus(200);

  const msg = req.body.message;
  if (msg && msg.text) {
    const text = msg.text.trim();

    if (text === '/list' || text.startsWith('/list ')) {
      const list = await col().find({ status: 'confirmed' }, { sort: { num: 1 } }).toArray();
      if (list.length === 0) {
        await tgSend({ chat_id: msg.chat.id, text: 'Немає активних бронювань.' });
      } else {
        let reply = '*📋 Активні бронювання:*\n\n';
        list.forEach(b => {
          reply += `№${b.num} · ${b.name} · ${fmt(b.checkin)} — ${fmt(b.checkout)} · ${guestsLine(b.adults||2, b.children||0)}\n`;
        });
        await tgSend({ chat_id: msg.chat.id, text: reply, parse_mode: 'Markdown' });
      }
      return;
    }

    const cancelMatch = text.match(/^\/cancel\s+(\d+)$/);
    if (cancelMatch) {
      const num = parseInt(cancelMatch[1]);
      const booking = await col().findOne({ num });
      if (!booking) {
        await tgSend({ chat_id: msg.chat.id, text: `❗ Бронювання №${num} не знайдено.` });
        return;
      }
      if (booking.status !== 'confirmed') {
        await tgSend({ chat_id: msg.chat.id, text: `ℹ️ Бронювання №${num} має статус: *${booking.status}*. Скасувати можна лише підтверджені.`, parse_mode: 'Markdown' });
        return;
      }
      await col().updateOne({ num }, { $set: { status: 'cancelled' } });
      await tgSend({
        chat_id: msg.chat.id,
        text: `🚫 *Бронювання №${num} СКАСОВАНО*\n\n${booking.name} · ${fmt(booking.checkin)} — ${fmt(booking.checkout)}\nДати звільнено на календарі.`,
        parse_mode: 'Markdown'
      });
      return;
    }

    if (text === '/help' || text === '/start') {
      await tgSend({
        chat_id: msg.chat.id,
        text:
          "*🏔️ Dzendz'o — Команди бота*\n\n" +
          '/list — показати всі активні бронювання\n' +
          '/cancel 5 — скасувати бронювання №5\n' +
          '/help — ця довідка',
        parse_mode: 'Markdown'
      });
      return;
    }
  }

  const cb = req.body.callback_query;
  if (!cb) return;

  const [action, numStr] = cb.data.split(':');
  const num = parseInt(numStr);
  const booking = await col().findOne({ num });
  if (!booking) return;

  if (action === 'confirm') {
    await col().updateOne({ num }, { $set: { status: 'confirmed' } });
    await tgEdit(cb.message.chat.id, cb.message.message_id,
      `✅ *Заявку №${num} ПІДТВЕРДЖЕНО*\n\n` +
      `Імʼя: ${booking.name}\nТелефон: ${booking.phone}\n` +
      `Заїзд: ${fmt(booking.checkin)} → Виїзд: ${fmt(booking.checkout)}\n` +
      `Гостей: ${guestsLine(booking.adults||2, booking.children||0)}\n` +
      `Сума: ₴ ${Number(booking.total).toLocaleString('uk-UA')}`
    );
    await tgSend({
      chat_id: TG_CHAT,
      text:
        `*Бронювання №${num} активне*\n\n` +
        `${booking.name} · ${fmt(booking.checkin)} — ${fmt(booking.checkout)}\n` +
        `${guestsLine(booking.adults||2, booking.children||0)}\n\n` +
        `Для скасування натисни кнопку або надішли: /cancel ${num}`,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [[{ text: '🚫 Скасувати бронювання', callback_data: `cancel:${num}` }]] }
    });

  } else if (action === 'reject') {
    await col().updateOne({ num }, { $set: { status: 'rejected' } });
    await tgEdit(cb.message.chat.id, cb.message.message_id,
      `❌ *Заявку №${num} ВІДХИЛЕНО*\n\n${booking.name} · ${fmt(booking.checkin)} — ${fmt(booking.checkout)}`
    );

  } else if (action === 'cancel') {
    if (booking.status !== 'confirmed') return;
    await col().updateOne({ num }, { $set: { status: 'cancelled' } });
    await tgEdit(cb.message.chat.id, cb.message.message_id,
      `🚫 *Бронювання №${num} СКАСОВАНО*\n\n` +
      `Імʼя: ${booking.name}\n` +
      `Заїзд: ${fmt(booking.checkin)} → Виїзд: ${fmt(booking.checkout)}\n` +
      `Дати звільнено на календарі.`
    );
  }

  fetch(`https://api.telegram.org/bot${TG_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: cb.id })
  });
});

app.get('/', (req, res) => res.send("Dzendz'o server is running"));

connectDB().then(() => {
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}).catch(err => {
  console.error('MongoDB connection failed:', err);
  process.exit(1);
});
