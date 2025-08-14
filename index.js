import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import axios from 'axios';

const {
  BOT_TOKEN,
  PUBLIC_URL,
  WEBHOOK_SECRET = 'secret',
  FLOWISE_BASE_URL,
  FLOWISE_FLOW_ID,
  FLOWISE_API_KEY
} = process.env;

const PORT = Number(process.env.PORT) || 8080;
const CLEAN_PUBLIC_URL = (PUBLIC_URL || '').replace(/\/+$/, '');
const CLEAN_FLOWISE_BASE_URL = (FLOWISE_BASE_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!CLEAN_FLOWISE_BASE_URL || !FLOWISE_FLOW_ID) {
  throw new Error('FLOWISE_BASE_URL and FLOWISE_FLOW_ID are required');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Health endpoints (для Railway health-check)
app.get('/', (_, res) => res.status(200).send('OK'));
app.get('/healthz', (_, res) => res.status(200).send('OK'));

// Webhook endpoint
const webhookPath = `/telegraf/${WEBHOOK_SECRET}`;
app.use(express.json());
app.use(bot.webhookCallback(webhookPath));

// /start
bot.start(async (ctx) => {
  await ctx.reply('Привіт! Пиши повідомлення — переправлю його до Flowise ✨');
});

// Проксируем текст в Flowise
bot.on('text', async (ctx) => {
  const text = ctx.message?.text ?? '';
  const userId = String(ctx.chat.id);
  try {
    const url = `${CLEAN_FLOWISE_BASE_URL}/prediction/${FLOWISE_FLOW_ID}`;
    const headers = { 'Content-Type': 'application/json' };
    if (FLOWISE_API_KEY) headers['Authorization'] = `Bearer ${FLOWISE_API_KEY}`;

    const payload = {
      question: text,
      overrideConfig: { sessionId: userId },
      streaming: false
    };

    const { data } = await axios.post(url, payload, { headers });
    const answer = data?.text ?? '🤖 (порожня відповідь)';
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (err) {
    console.error('Flowise error:', err?.response?.data || err.message);
    await ctx.reply('Ой, сталася помилка під час звернення до Flowise 🙈');
  }
});

let server;
async function boot() {
  // 1) стартуем HTTP-сервер (пусть health-check сразу видит 200 на /)
  server = app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

  // 2) регистрируем вебхук, когда сервер уже слушает порт
  if (CLEAN_PUBLIC_URL) {
    const fullWebhook = `${CLEAN_PUBLIC_URL}${webhookPath}`;
    await bot.telegram.setWebhook(fullWebhook);
    console.log('Webhook set ->', fullWebhook);
  } else {
    console.log('PUBLIC_URL not set yet. Set it in Railway env and restart to register webhook.');
  }
}

// Graceful shutdown
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