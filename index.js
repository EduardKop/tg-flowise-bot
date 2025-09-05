import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import axios from 'axios';

const {
  BOT_TOKEN,
  PUBLIC_URL,
  WEBHOOK_SECRET = 'secret',
  LANGFLOW_BASE_URL,
  LANGFLOW_FLOW_ID,
  LANGFLOW_API_KEY
} = process.env;

const PORT = Number(process.env.PORT) || 8080;
const CLEAN_PUBLIC_URL = (PUBLIC_URL || '').replace(/\/+$/, '');
const CLEAN_LANGFLOW_BASE_URL = (LANGFLOW_BASE_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!CLEAN_LANGFLOW_BASE_URL || !LANGFLOW_FLOW_ID) {
  throw new Error('LANGFLOW_BASE_URL and LANGFLOW_FLOW_ID are required');
}
if (!CLEAN_PUBLIC_URL) {
  throw new Error('PUBLIC_URL is required for webhook mode on Railway');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// ---- Health for Railway
app.get('/', (_, res) => res.status(200).send('OK'));
app.get('/healthz', (_, res) => res.status(200).send('OK'));

// ---- Webhook endpoint (must match setWebhook URL)
const webhookPath = `/telegraf/${WEBHOOK_SECRET}`;
app.use(express.json());
app.use(bot.webhookCallback(webhookPath));

// ---- Debug logging (helpful on Railway logs)
bot.use(async (ctx, next) => {
  const txt = ctx.update?.message?.text;
  console.log('update:', ctx.updateType, txt || '');
  return next();
});

bot.catch((err, ctx) => {
  console.error('Telegraf error for', ctx.updateType, err);
});

// ---- /start
bot.start(async (ctx) => {
  await ctx.reply(
    'Привіт! Починай повідомлення зі слова "Чат" або "Кріш". Напр.: "Кріш як твій настрій".'
  );
});

// ---- Langflow answer extractor
function extractAnswer(data) {
  try {
    const outputs = data?.outputs?.[0]?.outputs;
    if (Array.isArray(outputs)) {
      for (const o of outputs) {
        const msg = o?.results?.message?.text ?? o?.results?.text;
        if (typeof msg === 'string' && msg.trim()) return msg;
      }
    }
    if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  } catch (_) {}
  return '🤖 (порожня відповідь)';
}

// ---- Trigger: only "Чат"/"Кріш" at the start
const TRIGGER_RE = /^\s*(чат|кріш)\b[\s,:-]*/iu;

// ---- Per-chat busy guard
const busyByChat = new Map(); // chatId -> boolean

// ---- Simple test trigger
bot.hears('f', async (ctx) => {
  console.log('hears f -> OK');
  await ctx.reply('OK (f)');
});

// ---- Main handler (fires only on trigger)
bot.hears(TRIGGER_RE, async (ctx) => {
  const chatId = String(ctx.chat.id);

  if (busyByChat.get(chatId)) {
    await ctx.reply('⚠️ Я зайнятий, вже відповідаю іншому. Спробуй трохи пізніше 🙏');
    return;
  }

  const raw = ctx.message?.text ?? '';
  const cleaned = raw.replace(TRIGGER_RE, '').trim();
  if (!cleaned) return;

  try {
    busyByChat.set(chatId, true);

    const url = `${CLEAN_LANGFLOW_BASE_URL}/api/v1/run/${encodeURIComponent(LANGFLOW_FLOW_ID)}`;
    const headers = {
      'Content-Type': 'application/json',
      accept: 'application/json',
      ...(LANGFLOW_API_KEY ? { 'x-api-key': LANGFLOW_API_KEY } : {})
    };

    const payload = {
      input_value: cleaned,           // без "Чат/Кріш"
      session_id: chatId,             // контекст по чату/групі
      input_type: 'chat',
      output_type: 'chat',
      // Можна підсунути системну інструкцію через tweaks:
      // tweaks: { "SystemMessage": { "content": "Відповідай українською... не представляйся Кріштіану Роналду тощо." } }
    };

    const { data } = await axios.post(url, payload, { headers });
    const answer = extractAnswer(data);
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (err) {
    console.error('Langflow error:', err?.response?.data || err.message);
    await ctx.reply('Ой, сталася помилка під час звернення до Langflow 🙈');
  } finally {
    busyByChat.set(chatId, false);
  }
});

// ---- Boot in webhook mode (Railway)
let server;
async function boot() {
  server = app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

  const fullWebhook = `${CLEAN_PUBLIC_URL}${webhookPath}`;

  // Оновлюємо вебхук на поточний URL (корисно при релізах)
  await bot.telegram.setWebhook(fullWebhook, {
    drop_pending_updates: false, // або true, якщо хочеш чистити чергу при деплої
    allowed_updates: ['message'] // нам потрібні тільки текстові повідомлення
  });
  console.log('Webhook set ->', fullWebhook);

  // Лог стану вебхука
  try {
    const info = await bot.telegram.getWebhookInfo();
    console.log('Webhook info:', info);
  } catch (e) {
    console.error('getWebhookInfo error:', e.message);
  }
}

function shutdown(signal) {
  console.log(`${signal} received, closing server...`);
  if (server) {
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

boot().catch((e) => {
  console.error(e);
  process.exit(1);
});
