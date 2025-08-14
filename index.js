import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import axios from 'axios';

const {
  BOT_TOKEN,
  PORT = 3000,
  PUBLIC_URL,
  WEBHOOK_SECRET = 'secret',
  FLOWISE_BASE_URL,
  FLOWISE_FLOW_ID,
  FLOWISE_API_KEY
} = process.env;

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!FLOWISE_BASE_URL || !FLOWISE_FLOW_ID) {
  throw new Error('FLOWISE_BASE_URL and FLOWISE_FLOW_ID are required');
}
if (!PUBLIC_URL) {
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
  const text = ctx.message.text ?? '';
  const userId = String(ctx.chat.id); // stable per chat, good as sessionId
  try {
    const url = `${FLOWISE_BASE_URL}/prediction/${FLOWISE_FLOW_ID}`;
    const headers = {
      'Content-Type': 'application/json'
    };
    if (FLOWISE_API_KEY) {
      headers['Authorization'] = `Bearer ${FLOWISE_API_KEY}`;
    }

    const payload = {
      question: text,
      // keep context per user (Flowise accepts sessionId and optional history)
      overrideConfig: { sessionId: userId },
      streaming: false
    };

    const { data } = await axios.post(url, payload, { headers });
    // Flowise returns { text, json, sessionId, ... } per docs
    const answer = data?.text ?? '🤖 (порожня відповідь)';
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (err) {
    console.error('Flowise error:', err?.response?.data || err.message);
    await ctx.reply('Ой, сталася помилка під час звернення до Flowise 🙈');
  }
});

// Health-check
app.get('/', (_, res) => res.send('OK'));

// Set webhook on startup (only if PUBLIC_URL is provided)
async function boot() {
  if (PUBLIC_URL) {
    const fullWebhook = `${PUBLIC_URL}${webhookPath}`;
    await bot.telegram.setWebhook(fullWebhook);
    console.log('Webhook set ->', fullWebhook);
  } else {
    console.log('PUBLIC_URL not set yet. Set it in Railway env and restart to register webhook.');
  }
  app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
}

boot().catch((e) => {
  console.error(e);
  process.exit(1);
});