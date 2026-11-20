import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import * as S from './store.js';
import { LIBRARY, TONES } from './library.js';
import { suggestQuestions, aiEnabled } from './ai.js';

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN || '';
// На Render адрес сервиса приходит в RENDER_EXTERNAL_URL автоматически.
let WEBAPP_URL = process.env.WEBAPP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
// Вебхук нужен на хостинге, который «засыпает»: сообщение в Telegram будит сервер.
const USE_WEBHOOK = Boolean(process.env.RENDER_EXTERNAL_URL || process.env.USE_WEBHOOK === '1');
const HOOK_SECRET = crypto.createHash('sha256').update('hook:' + (process.env.BOT_TOKEN || '')).digest('hex').slice(0, 32);
// Демо-режим: без токена бота можно открыть приложение в браузере
// и переключаться между двумя партнёрами.
const DEMO = !BOT_TOKEN || process.env.DEMO === '1';

// ---------- Telegram-бот ----------
let bot = null;
let botUsername = '';
if (BOT_TOKEN) {
  bot = new Bot(BOT_TOKEN);
  const openBtn = (url, text = 'Открыть игру 💞') => new InlineKeyboard().webApp(text, url);

  bot.command('start', async (ctx) => {
    const payload = ctx.match || '';
    const url = payload.startsWith('join_')
      ? `${WEBAPP_URL}?join=${encodeURIComponent(payload.slice(5))}`
      : WEBAPP_URL;
    const text = payload.startsWith('join_')
      ? 'Вас пригласили в игру для пары 💞\nНажмите кнопку, чтобы присоединиться.'
      : 'Привет! Это игра для пар, которые застряли в споре или тупике.\n\n' +
        'Вы по очереди задаёте друг другу вопросы: свои, из библиотеки или подсказанные ИИ, ' +
        'который знает обе стороны, но никому не раскрывает чужие слова.';
    await ctx.reply(text, { reply_markup: openBtn(url) });
  });

  bot.catch((e) => console.error('Bot error:', e.message));
  bot.init().then(async () => {
    botUsername = bot.botInfo.username;
    // Сначала запускаем бота, чтобы он отвечал сразу, а адрес туннеля подхватываем потом.
    if (USE_WEBHOOK) {
      await bot.api.setWebhook(`${WEBAPP_URL}/tg/${HOOK_SECRET}`, { secret_token: HOOK_SECRET });
      console.log(`Бот @${botUsername} запущен (вебхук)`);
    } else {
      await bot.api.deleteWebhook();
      bot.start();
      console.log(`Бот @${botUsername} запущен`);
    }
    // На своём сервере без домена адрес даёт туннель Cloudflare (см. deploy/).
    if (process.env.TUNNEL_METRICS && !process.env.WEBAPP_URL) WEBAPP_URL = await tunnelUrl(process.env.TUNNEL_METRICS);
    // Кнопка «Играть» слева от поля ввода в чате с ботом.
    if (WEBAPP_URL.startsWith('https://')) {
      bot.api.setChatMenuButton({ menu_button: { type: 'web_app', text: 'Играть', web_app: { url: WEBAPP_URL } } })
        .catch((e) => console.error('menu button:', e.message));
    }
  }).catch((e) => console.error('ОШИБКА запуска бота (проверьте BOT_TOKEN):', e.message));
} else {
  console.error('BOT_TOKEN не задан: бот в Telegram не запущен, работает только демо-режим.');
}

async function tunnelUrl(metrics) {
  for (;;) {
    try {
      const r = await fetch(`${metrics}/quicktunnel`);
      const { hostname } = await r.json();
      if (hostname) {
        console.log(`Адрес мини-приложения: https://${hostname}`);
        return `https://${hostname}`;
      }
    } catch {}
    await new Promise((res) => setTimeout(res, 2000));
  }
}

async function notify(uid, text) {
  if (!bot || String(uid).startsWith('demo')) return;
  try {
    await bot.api.sendMessage(uid, text, {
      reply_markup: new InlineKeyboard().webApp('Открыть 💞', WEBAPP_URL),
    });
  } catch (e) {
    console.error('notify failed:', e.message);
  }
}

// ---------- Проверка пользователя Telegram ----------
function checkInitData(initData) {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');
  const dataCheck = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheck).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(params.get('auth_date')) > 86400) return null;
  const user = JSON.parse(params.get('user') || 'null');
  return user && { id: String(user.id), name: user.first_name || user.username || 'Партнёр' };
}

function auth(req, res, next) {
  let who = null;
  const initData = req.get('X-Init-Data');
  if (initData && BOT_TOKEN) who = checkInitData(initData);
  if (!who && DEMO) {
    const d = req.get('X-Demo-User');
    if (d === 'demoA') who = { id: 'demoA', name: 'Аня' };
    if (d === 'demoB') who = { id: 'demoB', name: 'Боря' };
  }
  if (!who) return res.status(401).json({ error: 'Откройте приложение из Telegram' });
  req.user = S.upsertUser(who.id, S.getUser(who.id)?.name || who.name);
  next();
}

// ---------- Что нравится каждому ----------
const SCORE = { love: 2, like: 1, meh: 0 };
function insights(pid, uid) {
  const got = S.pairQuestions(pid).filter((q) => q.to === uid && q.rating);
  const by = (key) => {
    const m = {};
    for (const q of got) {
      m[q[key]] ??= { sum: 0, n: 0 };
      m[q[key]].sum += SCORE[q.rating];
      m[q[key]].n += 1;
    }
    return Object.entries(m)
      .map(([k, v]) => ({ key: k, avg: v.sum / v.n, n: v.n }))
      .sort((a, b) => b.avg - a.avg || b.n - a.n);
  };
  const loved = got.filter((q) => q.rating === 'love').slice(-3).map((q) => q.text);
  return { rated: got.length, byTone: by('tone'), bySource: by('source'), loved };
}

function publicQ(q, users) {
  return {
    id: q.id, from: q.from, to: q.to, fromName: users[q.from]?.name, text: q.text,
    tone: q.tone, source: q.source, answer: q.answer, rating: q.rating,
    createdAt: q.createdAt, answeredAt: q.answeredAt,
  };
}

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.resolve('public')));
if (bot && USE_WEBHOOK) app.post(`/tg/${HOOK_SECRET}`, webhookCallback(bot, 'express', { secretToken: HOOK_SECRET }));
app.get('/health', (req, res) => res.send('ok'));

app.get('/api/config', (req, res) => res.json({ demo: DEMO, aiEnabled, tones: TONES }));

app.use('/api', auth);

app.get('/api/state', (req, res) => {
  const me = req.user;
  const pair = me.pairId && S.getPair(me.pairId);
  const base = {
    me: { id: me.id, name: me.name, tone: me.tone, situation: me.situation },
    aiEnabled,
  };
  if (!pair) return res.json({ ...base, pair: null });

  const partnerId = S.partnerOf(pair, me.id);
  const partner = partnerId && S.getUser(partnerId);
  const users = { [me.id]: me, ...(partner ? { [partner.id]: partner } : {}) };
  const open = S.openQuestion(pair.id);
  res.json({
    ...base,
    pair: {
      code: pair.code,
      invite: botUsername ? `https://t.me/${botUsername}?start=join_${pair.code}` : null,
      myTurn: pair.turn === me.id && !open,
    },
    // Партнёр видит только имя и выбранный тон. Его «сторона» не передаётся.
    partner: partner && { name: partner.name, tone: partner.tone, sideFilled: Boolean(partner.situation) },
    open: open ? publicQ(open, users) : null,
    history: S.pairQuestions(pair.id).filter((q) => q.answer != null).map((q) => publicQ(q, users)).reverse(),
    insights: { me: insights(pair.id, me.id), partner: partner ? insights(pair.id, partner.id) : null },
  });
});

app.post('/api/profile', (req, res) => {
  const { name, tone, situation } = req.body;
  const patch = {};
  if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 40);
  if (tone in TONES) patch.tone = tone;
  if (typeof situation === 'string') patch.situation = situation.slice(0, 4000);
  S.updateUser(req.user.id, patch);
  res.json({ ok: true });
});

app.post('/api/pair/create', (req, res) => {
  if (req.user.pairId) return res.status(400).json({ error: 'Вы уже в паре' });
  res.json(S.createPair(req.user.id));
});

app.post('/api/pair/join', (req, res) => {
  if (req.user.pairId) return res.status(400).json({ error: 'Вы уже в паре' });
  try {
    const p = S.joinPair(req.user.id, req.body.code || '');
    notify(S.partnerOf(p, req.user.id), `${req.user.name} присоединился(ась) к игре 💞`);
    res.json(p);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/pair/leave', (req, res) => {
  S.leavePair(req.user.id);
  res.json({ ok: true });
});

function requireTurn(req, res) {
  const pair = req.user.pairId && S.getPair(req.user.pairId);
  const partnerId = pair && S.partnerOf(pair, req.user.id);
  if (!partnerId) { res.status(400).json({ error: 'Сначала пригласите партнёра' }); return null; }
  if (pair.turn !== req.user.id || S.openQuestion(pair.id)) { res.status(400).json({ error: 'Сейчас не ваш ход' }); return null; }
  return { pair, partner: S.getUser(partnerId) };
}

app.get('/api/library', (req, res) => {
  const tone = req.query.tone in TONES ? req.query.tone : 'gentle';
  const asked = new Set(req.user.pairId ? S.pairQuestions(req.user.pairId).map((q) => q.text) : []);
  res.json({ questions: LIBRARY[tone].map((text) => ({ text, asked: asked.has(text) })) });
});

app.post('/api/ai/suggest', async (req, res) => {
  const ctx = requireTurn(req, res);
  if (!ctx) return;
  const tone = req.body.tone in TONES ? req.body.tone : ctx.partner.tone || 'gentle';
  const users = { [req.user.id]: req.user, [ctx.partner.id]: ctx.partner };
  const history = S.pairQuestions(ctx.pair.id).map((q) => ({ ...q, fromName: users[q.from]?.name }));
  const out = await suggestQuestions({ tone, asker: req.user, receiver: ctx.partner, history });
  res.json(out);
});

app.post('/api/question', (req, res) => {
  const ctx = requireTurn(req, res);
  if (!ctx) return;
  const text = String(req.body.text || '').trim().slice(0, 500);
  if (!text) return res.status(400).json({ error: 'Пустой вопрос' });
  const tone = req.body.tone in TONES ? req.body.tone : 'gentle';
  const source = ['own', 'library', 'ai'].includes(req.body.source) ? req.body.source : 'own';
  const q = S.addQuestion({ pairId: ctx.pair.id, from: req.user.id, to: ctx.partner.id, text, tone, source });
  notify(ctx.partner.id, `💌 ${req.user.name} задал(а) вам вопрос. Откройте игру, чтобы ответить.`);
  res.json(q);
});

app.post('/api/answer', (req, res) => {
  const pair = req.user.pairId && S.getPair(req.user.pairId);
  const open = pair && S.openQuestion(pair.id);
  if (!open || open.to !== req.user.id) return res.status(400).json({ error: 'Нет вопроса для ответа' });
  const answer = String(req.body.answer || '').trim().slice(0, 2000);
  if (!answer) return res.status(400).json({ error: 'Напишите ответ' });
  const rating = ['love', 'like', 'meh'].includes(req.body.rating) ? req.body.rating : null;
  S.answerQuestion(open.id, answer, rating);
  notify(open.from, `✨ ${req.user.name} ответил(а) на ваш вопрос. Теперь ход за ним/ней.`);
  res.json({ ok: true });
});

try {
  await S.initStore();
} catch (e) {
  console.error('ОШИБКА подключения к базе (проверьте DATABASE_URL):', e.message);
  delete process.env.DATABASE_URL;
  await S.initStore();
}
app.listen(PORT, () => {
  console.log(`Мини-приложение: http://localhost:${PORT}  (демо-режим: ${DEMO ? 'да' : 'нет'}, ИИ: ${aiEnabled ? 'Claude' : 'библиотека'})`);
});
