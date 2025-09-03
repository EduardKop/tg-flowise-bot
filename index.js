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
  // якщо назва останнього блоку у флоу інша – змінюй змінною середовища
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

// health
app.get('/', (_, res) => res.status(200).send('OK'));
app.get('/healthz', (_, res) => res.status(200).send('OK'));

// webhook
const webhookPath = `/telegraf/${WEBHOOK_SECRET}`;
app.use(express.json({ limit: '1mb' }));
app.use(bot.webhookCallback(webhookPath));

bot.start(async (ctx) => {
  await ctx.reply('Привіт! Пиши повідомлення — я передам його у Langflow ✨');
});

// ---- helper: дістаємо текст з відповіді Langflow ----
function extractAnswer(data) {
  try {
    const outArr = data && data.outputs;
    if (Array.isArray(outArr) && outArr.length > 0) {
      // шукаємо саме наш component_name (останній вузол у флоу)
      const hit =
        outArr.find((x) => x && x.component_name === LANGFLOW_OUTPUT_COMPONENT) ||
        outArr[0];

      const outs = hit && hit.outputs;
      if (Array.isArray(outs)) {
        for (const o of outs) {
          const txt =
            (o && o.results && o.results.message && o.results.message.text) ??
            (o && o.results && o.results.text) ??
            (o && o.results && o.results.output_text) ??
            (o && o.data && o.data.text) ??
            (o && o.data && o.data.output_text) ??
            o?.content ??
            null;
          if (typeof txt === 'string' && txt.trim()) return txt;
        }
      }
    }
    if (typeof data?.message === 'string' && data.message.trim()) return data.message;
  } catch (e) {
    console.error('extractAnswer error:', e);
  }
  return '🤖 (порожня відповідь)';
}

// ---- main handler ----
bot.on('text', async (ctx) => {
  const text = ctx.message?.text ?? '';
  const userId = String(ctx.chat.id);

  try { await ctx.sendChatAction('typing'); } catch {}

  try {
    const url = `${CLEAN_LANGFLOW_BASE_URL}/api/v1/run/${encodeURIComponent(LANGFLOW_FLOW_ID)}?stream=false`;

    const headers = {
      'content-type': 'application/json',
      accept: 'application/json',
    };
    if (LANGFLOW_API_KEY) headers['x-api-key'] = LANGFLOW_API_KEY;

    // ВАЖЛИВО:
    // - залишаємо Text Input у кінці флоу → просимо саме його вихід
    // - input_type: 'text' (ми передаємо текст прямо в агент)
    // - output_type: 'text' (очікуємо текст від кінцевого вузла)
    const payload = {
      input_value: text,
      session_id: userId,
      input_type: 'text',
      output_type: 'text',
      output_component: LANGFLOW_OUTPUT_COMPONENT, // наприклад: "Text Input"
      // tweaks: {} // за потреби
    };

    const { data } = await axios.post(url, payload, {
      headers,
      timeout: 30000,
      maxContentLength: 10_000_000,
      maxBodyLength: 10_000_000,
    });

    const answer = extractAnswer(data);

    // якщо агент повертає HTML, рендеримо його
    await ctx.reply(answer, {
      parse_mode: 'HTML', // якщо хочеш plain text — прибери цей рядок
      disable_web_page_preview: false,
      reply_to_message_id: ctx.message.message_id,
    });

  } catch (err) {
    const status = err?.response?.status;
    const body = err?.response?.data;

    console.error('Langflow error:', {
      status,
      headers: err?.response?.headers,
      body,
      message: err?.message,
    });

    if (status === 401 || status === 403) {
      await ctx.reply('⛔️ Немає доступу до Langflow API. Перевір LANGFLOW_API_KEY/права.');
      return;
    }
    if (status === 404) {
      await ctx.reply('🔎 Flow не знайдено. Перевір LANGFLOW_FLOW_ID або URL.');
      return;
    }
    if (status === 413) {
      await ctx.reply('📦 Повідомлення надто велике. Спробуй коротше.');
      return;
    }

    await ctx.reply('Ой, сталася помилка під час звернення до Langflow 🙈');
  }
});

// boot
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
  if (server) server.close(() => { console.log('HTTP server closed'); process.exit(0); });
  else process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

boot().catch((e) => {
  console.error(e);
  process.exit(1);
});
