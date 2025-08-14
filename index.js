import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import axios from 'axios';

// --- env & normalization ---
const {
  BOT_TOKEN,
  PUBLIC_URL,
  WEBHOOK_SECRET = 'secret',
  FLOWISE_BASE_URL,
  FLOWISE_FLOW_ID,
  FLOWISE_API_KEY
} = process.env;

// Railway задаёт свой порт в process.env.PORT.
// Локально подставим 8080, если переменная не задана.
const PORT = Number(process.env.PORT) || 8080;

// Уберём завершающие слэши, чтобы не получить двойной //
const CLEAN_PUBLIC_URL = (PUBLIC_URL || '').replace(/\/+$/, '');
const CLEAN_FLOWISE_BASE_URL = (FLOWISE_BASE_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!CLEAN_FLOWISE_BASE_URL || !FLOWISE_FLOW_ID) {
  throw new Error('FLOWISE_BASE_URL and FLOWISE_FLOW_ID are required');
}
if (!CLEAN_PUBLIC_URL) {
  console.warn('PUBLIC_URL is not set yet. Set it in Railway env after first deploy.');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Telegram will POST updates here:
const webhookPath = `/telegraf/${WEBHOOK_SECRET}`;
app.use(express.json());
app.use(bot.webhookCallback(webhookPath));

// Simple /start
bot.start(async (ctx) => {
  await ctx.reply('Привіт! Пиши повідомлення — переправлю його до Flowise ✨');
});

// Forward every text message to Flowise Prediction API
bot.on('text', async (ctx) => {
  const text = ctx.message?.text ?? '';
  const userId = String(ctx.chat.id); // stable per chat, good as sessionId
  try {
    const url = `${CLEAN_FLOWISE_BASE_URL}/prediction/${FLOWISE_FLOW_ID}`;
    const headers = { 'Content-Type': 'application/json' };
    if (FLOWISE_API_KEY) headers['Authorization'] = `Bearer ${FLOWISE_API_KEY}`;

    const payload = {
      question: text,
      // keep context per user (Flowise accepts sessionId and optional history)
      overrideConfig: { sessionId: userId },
      streaming: false
    };

    const { data } = await axios.post(url, payload, { headers });
    const answer = data?.text ?? '🤖 (порожня відповідь)';
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (err) {
    const msg = err?.response?.data || err.message;
    console.error('Flowise error:', msg);
    await ctx.reply('Ой, сталася помилка під час звернення до Flowise 🙈');
  }
});

// Health-check
app.get('/', (_, res) => res.send('OK'));

// Boot: set webhook & start server
let server;
async function boot() {
  if (CLEAN_PUBLIC_URL) {
    const fullWebhook = `${CLEAN_PUBLIC_URL}${webhookPath}`;
    await bot.telegram.setWebhook(fullWebhook);
    console.log('Webhook set ->', fullWebhook);
  } else {
    console.log('PUBLIC_URL not set yet. Set it in Railway env and restart to register webhook.');
  }
  server = app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
}

// Graceful shutdown (Railway посылает SIGTERM)
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