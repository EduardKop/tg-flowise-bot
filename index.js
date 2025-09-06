import 'dotenv/config';
import express from 'express';
import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import axios from 'axios';
import { ALLOWED_CHATS, ALLOWED_USERS } from './access.js';

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
// відповіді через sendMessage (а не webhook HTTP-відповідь)
bot.telegram.webhookReply = false;

const app = express();

// Health
app.get('/', (_, res) => res.status(200).send('OK'));
app.get('/healthz', (_, res) => res.status(200).send('OK'));

// --- власний webhook-роут: 200 одразу, обробка асинхронно
const webhookPath = `/telegraf/${WEBHOOK_SECRET}`;
app.post(webhookPath, express.json(), (req, res) => {
  res.sendStatus(200);
  Promise.resolve(bot.handleUpdate(req.body)).catch((e) =>
    console.error('handleUpdate error:', e)
  );
});

// ----- ЛОГИ: показуємо chatId, type, thread, fromId і текст
bot.use(async (ctx, next) => {
  const txt = ctx.update?.message?.text || '';
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;
  const threadId = ctx.message?.message_thread_id;
  const fromId = ctx.from?.id;
  console.log(
    `update: ${ctx.updateType} chatId=${chatId} type=${chatType} thread=${threadId ?? '-'} from=${fromId} text="${txt}"`
  );
  return next();
});

bot.catch((err, ctx) => {
  console.error('Telegraf error for', ctx.updateType, err);
});

// /start
bot.start(async (ctx) => {
  await ctx.reply(
    'Привіт! Починай повідомлення зі слова "Чат" або "Кріш". Напр.: "Кріш як твій настрій".'
  );
});

// дістаємо текст із відповіді Langflow
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

// тригер (юнікод, без \b): початок рядка "чат"/"кріш"
const TRIGGER_RE = /^\s*(?:чат|кріш)(?=[\s,.:;!?-]|$)/iu;

// захист від конкурентних запитів (по чату)
const busyByChat = new Map(); // chatId -> true/false
const BUSY_RESET_MS = 120_000;

// --- КОМАНДА "id" (ДОСТУПНА ВСЮДИ, БЕЗ ДОЗВОЛІВ)
bot.on(message('text'), async (ctx, next) => {
  const text = (ctx.message.text || '').trim().toLowerCase();
  if (text === 'id') {
    const chatId = String(ctx.chat.id);
    const fromId = String(ctx.from.id);
    const chatType = ctx.chat.type;
    const threadId = ctx.message?.message_thread_id;
    console.log(`[id] chatId=${chatId} type=${chatType} thread=${threadId ?? '-'} from=${fromId}`);
    await ctx.reply(`chatId: ${chatId}\nfromId: ${fromId}`);
    return; // не йдемо далі
  }
  return next();
});

// тест (опційно)
bot.on(message('text'), async (ctx, next) => {
  if ((ctx.message.text || '') === 'f') {
    console.log(`TEST hears f -> OK (chatId=${ctx.chat?.id})`);
    await ctx.reply('OK (f)');
    return;
  }
  return next();
});

// основний хендлер
bot.on(message('text'), async (ctx) => {
  const chatId = String(ctx.chat.id);
  const userId = String(ctx.from.id);
  const raw = ctx.message.text || '';

  // реагуємо тільки на "чат/кріш" на початку
  if (!TRIGGER_RE.test(raw)) return;

  // ---- ДОСТУП: тільки якщо chatId у ALLOWED_CHATS АБО userId у ALLOWED_USERS
  const isAllowed = ALLOWED_CHATS.has(chatId) || ALLOWED_USERS.has(userId);
  if (!isAllowed) {
    console.log(`blocked: chatId=${chatId} userId=${userId}`);
    await ctx.reply('Бот поки працює виключно у шаразі.');
    return;
  }

  const cleaned = raw
    .replace(TRIGGER_RE, '')
    .replace(/^[\s,.:;!?-]+/, '')
    .trim();

  console.log(`trigger matched (chatId=${chatId}), cleaned="${cleaned}"`);
  if (!cleaned) return;

  if (busyByChat.get(chatId)) {
    console.log(`busy reply -> chatId=${chatId}`);
    await ctx.reply('⚠️ Я зайнятий, вже відповідаю іншому. Спробуй трохи пізніше 🙏', {
      reply_to_message_id: ctx.message.message_id
    });
    return;
  }

  let resetTimer;
  try {
    busyByChat.set(chatId, true);
    resetTimer = setTimeout(() => busyByChat.set(chatId, false), BUSY_RESET_MS);

    const url = `${CLEAN_LANGFLOW_BASE_URL}/api/v1/run/${encodeURIComponent(LANGFLOW_FLOW_ID)}`;
    const headers = {
      'Content-Type': 'application/json',
      accept: 'application/json',
      ...(LANGFLOW_API_KEY ? { 'x-api-key': LANGFLOW_API_KEY } : {})
    };

    // --- Формуємо sender/sender_name
    const tg = ctx.from || {};
    const humanName = [tg.first_name, tg.last_name].filter(Boolean).join(' ').trim();
    const sender_name = humanName || tg.username || `user_${userId}`;
    const sender = tg.username ? `@${tg.username}` : (humanName || 'User');

    // --- ПЕРЕДАЄМО значення у вузли "Chat Input" і "Name".
    // ВАЖЛИВО: НЕ передаємо input_value у tweaks['Chat Input'], щоб уникнути конфлікту.
    const payload = {
      input_value: cleaned,              // <-- тільки тут
      session_id: String(chatId),
      input_type: 'chat',
      output_type: 'chat',
      sender,
      sender_name,
      tweaks: {
        'Chat Input': {
          sender,
          sender_name
          // НЕ додавати input_value тут!
        },
        'Name': {
          text: sender_name
        }
      }
    };

    const { data } = await axios.post(url, payload, { headers });
    const answer = extractAnswer(data) || '🤖 (порожня відповідь)';

    console.log(`reply -> chatId=${chatId}, length=${answer.length}`);
    await ctx.reply(answer, { reply_to_message_id: ctx.message.message_id });
  } catch (err) {
    console.error('Langflow error:', err?.response?.data || err.message, `(chatId=${chatId})`);
    await ctx.reply('Ой, сталася помилка під час звернення до Langflow 🙈', {
      reply_to_message_id: ctx.message.message_id
    });
  } finally {
    if (resetTimer) clearTimeout(resetTimer);
    busyByChat.set(chatId, false);
  }
});

// запуск (webhook only)
let server;
async function boot() {
  server = app.listen(PORT, () => console.log(`Server listening on ${PORT}`));

  const fullWebhook = `${CLEAN_PUBLIC_URL}${webhookPath}`;
  await bot.telegram.setWebhook(fullWebhook, {
    drop_pending_updates: false,
    allowed_updates: ['message']
  });
  console.log('Webhook set ->', fullWebhook);

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
