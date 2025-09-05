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
  await ctx.reply(
    'Привет! Чтобы я отвечал, начинай сообщение со слова "Чат" или "Кріш".\nНапр.: "Кріш как твой настрой" или "чат, подскажи...".'
  );
});

// Достаём текст из ответа Langflow
function extractAnswer(data) {
  try {
    const outputs = data?.outputs?.[0]?.outputs;
    if (Array.isArray(outputs)) {
      for (const o of outputs) {
        const msg =
          o?.results?.message?.text ??
          o?.results?.text;
        if (typeof msg === 'string' && msg.trim()) return msg;
      }
    }
    if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  } catch (_) {}
  return '🤖 (порожня відповідь)';
}

/**
 * ТРИГЕР:
 * — Срабатывает ТОЛЬКО если сообщение НАЧИНАЕТСЯ со слова "Чат" или "Кріш" (любая раскладка/регистр).
 * — Удаляем триггер + разделители после него и пробелы.
 * — Если триггера нет — бот молчит.
 */
const TRIGGER_RE = /^\s*(чат|кріш)\b[\s,:-]*/iu;

bot.on('text', async (ctx) => {
  const raw = ctx.message?.text ?? '';
  const match = raw.match(TRIGGER_RE);

  // нет триггера — игнорим
  if (!match) return;

  // вырезаем "Чат"/"Кріш" и разделители
  const cleaned = raw.replace(TRIGGER_RE, '').trim();

  // пусто после вырезания — тоже молчим
  if (!cleaned) return;

  const userId = String(ctx.chat.id);

  try {
    const url = `${CLEAN_LANGFLOW_BASE_URL}/api/v1/run/${encodeURIComponent(LANGFLOW_FLOW_ID)}`;

    const headers = {
      'Content-Type': 'application/json',
      accept: 'application/json',
    };
    if (LANGFLOW_API_KEY) headers['x-api-key'] = LANGFLOW_API_KEY;

    const payload = {
      input_value: cleaned,   // <-- в Langflow уходит только текст без "Чат/Кріш"
      session_id: userId,
      input_type: 'chat',
      output_type: 'chat'
    };

    const { data } = await axios.post(url, payload, { headers });
    const answer = extractAnswer(data);
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (err) {
    console.error('Langflow error:', err?.response?.data || err.message);
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
