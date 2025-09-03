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
  LANGFLOW_API_KEY,
  // назва кінцевого блоку у флоу (заміни, якщо інша)
  LANGFLOW_OUTPUT_COMPONENT = 'Text Input',
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

/* ---------- health ---------- */
app.get('/', (_, res) => res.status(200).send('OK'));
app.get('/healthz', (_, res) => res.status(200).send('OK'));

/* ---------- webhook ---------- */
const webhookPath = `/telegraf/${WEBHOOK_SECRET}`;
app.use(express.json({ limit: '1mb' }));
// важливо: secretToken
app.use(bot.webhookCallback(webhookPath, { secretToken: WEBHOOK_SECRET }));

bot.start(async (ctx) => {
  await ctx.reply('Привіт! Пиши повідомлення — я передам його у Langflow ✨');
});

/* ---------- helpers ---------- */

// Безпечний stringify для логів
function safeStringify(obj) {
  try { return JSON.stringify(obj, null, 2); } catch { return String(obj); }
}

// Витяг тексту з відповіді Langflow (макс. універсально)
function extractAnswer(data, preferComponentName) {
  try {
    if (!data) return null;

    const outputsArr = Array.isArray(data.outputs) ? data.outputs : [];
    if (outputsArr.length) {
      const section =
        outputsArr.find((x) => x?.component_name === preferComponentName) ??
        outputsArr[0];

      const outs = Array.isArray(section?.outputs) ? section.outputs : [];
      for (const o of outs) {
        const txt =
          o?.results?.message?.text ??
          o?.results?.text ??
          o?.results?.output_text ??
          o?.data?.text ??
          o?.data?.output_text ??
          (typeof o?.content === 'string' ? o.content : null);

        if (typeof txt === 'string' && txt.trim()) return txt;
      }
    }

    if (typeof data?.text === 'string' && data.text.trim()) return data.text;
    if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  } catch (e) {
    console.error('extractAnswer error:', e);
  }
  return null;
}

// Коротке повідомлення для користувача у разі помилки
function humanError(err) {
  const status = err?.response?.status;
  const msg = err?.message || 'Unknown error';
  const body = err?.response?.data;
  let brief = `Статус: ${status ?? '—'}. ${msg}`;
  if (body?.detail) brief += ` | Деталі: ${body.detail}`;
  return brief;
}

/* ---------- main handler ---------- */

bot.on('text', async (ctx) => {
  const text = ctx.message?.text ?? '';
  const userId = String(ctx.chat.id);

  try { await ctx.sendChatAction('typing'); } catch {}

  const url = `${CLEAN_LANGFLOW_BASE_URL}/api/v1/run/${encodeURIComponent(LANGFLOW_FLOW_ID)}?stream=false`;
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...(LANGFLOW_API_KEY ? { 'x-api-key': LANGFLOW_API_KEY } : {})
  };

  const payload = {
    input_value: text,            // вхід із Telegram
    session_id: userId,           // контекст чату
    input_type: 'text',           // даємо текст прямо в Agent
    output_type: 'text',          // очікуємо текст
    output_component: LANGFLOW_OUTPUT_COMPONENT, // "Text Input" (останній вузол)
    // tweaks: {}
  };

  console.log('LF request ->', safeStringify({ url, payload }));

  try {
    const { data } = await axios.post(url, payload, {
      headers,
      timeout: 30000,
      maxContentLength: 10_000_000,
      maxBodyLength: 10_000_000
    });

    console.log('LF raw response <-');
    console.dir(data, { depth: null });

    const answer = extractAnswer(data, LANGFLOW_OUTPUT_COMPONENT);

    if (!answer || !String(answer).trim()) {
      console.warn('LF: empty answer extracted');
      await ctx.reply('🤖 (порожня відповідь від флоу)');
      return;
    }

    await ctx.reply(String(answer), {
      parse_mode: 'HTML',              // при plain text — прибери цей рядок
      disable_web_page_preview: false,
      reply_to_message_id: ctx.message.message_id
    });

  } catch (err) {
    console.error('Langflow error FULL:', safeStringify({
      status: err?.response?.status,
      headers: err?.response?.headers,
      body: err?.response?.data,
      message: err?.message,
      url
    }));
    await ctx.reply(`Ой, сталася помилка під час звернення до Langflow 🙈\n${humanError(err)}`);
  }
});

/* ---------- boot (ідемпотентний webhook) ---------- */

let server;
async function boot() {
  server = app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

  if (!CLEAN_PUBLIC_URL) {
    console.log('PUBLIC_URL not set yet. Set it in Railway env and restart to register webhook.');
    return;
  }

  const fullWebhook = `${CLEAN_PUBLIC_URL}${webhookPath}`;

  try {
    const info = await bot.telegram.getWebhookInfo();
    const currentUrl = info?.url || '';

    if (currentUrl !== fullWebhook) {
      try {
        await bot.telegram.setWebhook(fullWebhook, {
          drop_pending_updates: true,
          max_connections: 40
          // secretToken для перевірки підпису — вже вказаний у webhookCallback вище
        });
        console.log('Webhook set ->', fullWebhook);
      } catch (e) {
        const retryAfter = e?.response?.parameters?.retry_after || 0;
        if (e?.response?.error_code === 429 && retryAfter > 0) {
          console.warn(`setWebhook 429: retrying after ${retryAfter}s...`);
          await new Promise(r => setTimeout(r, (retryAfter + 1) * 1000));
          await bot.telegram.setWebhook(fullWebhook, {
            drop_pending_updates: true,
            max_connections: 40
          });
          console.log('Webhook set (after retry) ->', fullWebhook);
        } else {
          console.error('setWebhook error (ignored):', e?.response?.description || e?.message);
        }
      }
    } else {
      console.log('Webhook already set ->', currentUrl);
    }
  } catch (e) {
    console.error('getWebhookInfo error:', e?.message || e);
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
