import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import axios from 'axios';

const {
  BOT_TOKEN,
  PUBLIC_URL,
  WEBHOOK_SECRET = 'secret',
  LANGFLOW_BASE_URL,   // базовый URL твоего Langflow на Railway (без завершающего /)
  LANGFLOW_FLOW_ID,    // Flow ID или alias из Share → API Access
  LANGFLOW_API_KEY     // API key, если включена авторизация в Langflow
} = process.env;

const PORT = Number(process.env.PORT) || 8080;
const CLEAN_PUBLIC_URL = (PUBLIC_URL || '').replace(/\/+$/, '');
const CLEAN_LANGFLOW_BASE_URL = (LANGFLOW_BASE_URL || '').replace(/\/+$/, '');

if (!BOT_TOKEN) throw new Error('BOT_TOKEN is required');
if (!CLEAN_LANGFLOW_BASE_URL || !LANGFLOW_FLOW_ID) {
  throw new Error('LANGFLOW_BASE_URL and LANGFLOW_FLOW_ID are required');
}

const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Health endpoints (для Railway health-check)
app.get('/', (_, res) => res.status(200).send('OK'));
app.get('/healthz', (_, res) => res.status(200).send('OK'));

// Webhook endpoint
const webhookPath = `/telegraf/${WEBHOOK_SECRET}`;
app.use(express.json({ limit: '1mb' }));
app.use(bot.webhookCallback(webhookPath));

// /start
bot.start(async (ctx) => {
  await ctx.reply('Привіт! Пиши повідомлення — переправлю його до Langflow ✨');
});

// Достаём текст из ответа Langflow
function extractAnswer(data) {
  try {
    const outputs = data?.outputs?.[0]?.outputs;
    if (Array.isArray(outputs)) {
      for (const o of outputs) {
        const msg =
          o?.results?.message?.text ??
          o?.results?.text ??
          null;
        if (typeof msg === 'string' && msg.trim()) return msg;
      }
    }
    if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  } catch (_) {}
  return '🤖 (порожня відповідь)';
}

// Проксируем текст в Langflow
bot.on('text', async (ctx) => {
  const text = ctx.message?.text ?? '';
  const userId = String(ctx.chat.id);

  // маленький UX: показать "typing…"
  try { await ctx.sendChatAction('typing'); } catch {}

  try {
    const url = `${CLEAN_LANGFLOW_BASE_URL}/api/v1/run/${encodeURIComponent(LANGFLOW_FLOW_ID)}`;

    const headers = {
      'Content-Type': 'application/json',
      'accept': 'application/json',
      ...(LANGFLOW_API_KEY ? { 'x-api-key': LANGFLOW_API_KEY } : {})
    };

    const payload = {
      input_value: text,
      session_id: userId,   // чтобы удерживать контекст по чату
      input_type: 'chat',
      output_type: 'chat'
      // output_component: 'ChatOutput', // раскомментируй при необходимости
      // tweaks: {}
    };

    const { data } = await axios.post(url, payload, {
      headers,
      timeout: 30000,         // 30s таймаут на запрос
      maxContentLength: 10_000_000,
      maxBodyLength: 10_000_000
    });

    const answer = extractAnswer(data);
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });

  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;

    console.error('Langflow error:', {
      status,
      body: typeof body === 'object' ? JSON.stringify(body) : body,
      message: err?.message
    });

    // чуть более полезные сообщения для распространённых статусов
    if (status === 401 || status === 403) {
      await ctx.reply('⛔️ Немає доступу до Langflow API. Перевір API key (LANGFLOW_API_KEY) або налаштування доступу.');
      return;
    }
    if (status === 404) {
      await ctx.reply('🔎 Flow не знайдено. Перевір LANGFLOW_FLOW_ID або URL Langflow.');
      return;
    }
    if (status === 413) {
      await ctx.reply('📦 Повідомлення занадто велике. Спробуй надіслати коротший текст.');
      return;
    }

    await ctx.reply('Ой, сталася помилка під час звернення до Langflow 🙈');
  }
});

let server;
async function boot() {
  server = app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

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
