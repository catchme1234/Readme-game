import express from 'express';
import crypto from 'node:crypto';
import path from 'node:path';
import { Bot, InlineKeyboard, webhookCallback } from 'grammy';
import * as S from './store.js';
import { LIBRARY, TONES, STAGES, TOPICS, STAGE_Q } from './library.js';
import * as T from './talk.js';
import { suggestQuestions, aiEnabled } from './ai.js';
import * as D from './daily.js';
import * as G from './signals.js';
import { flagged, HELP } from './safety.js';
import { repeatCount, REPEAT_AT, themeQuestions } from './theme.js';

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
  const openBtn = (url, text = 'Открыть ReadMe 📖') => new InlineKeyboard().webApp(text, url);

  bot.command('start', async (ctx) => {
    const payload = ctx.match || '';
    const url = payload.startsWith('join_')
      ? `${WEBAPP_URL}?join=${encodeURIComponent(payload.slice(5))}`
      : WEBAPP_URL;
    const text = payload.startsWith('join_')
      ? 'Вас пригласили в ReadMe 📖\nПрочитай меня, а я тебя. Нажмите кнопку, чтобы присоединиться.'
      : 'Привет! Это ReadMe: прочитай меня, а я тебя 📖\n\n' +
        'Для пар, которые застряли в споре или тупике. ' +
        'Когда поссорились и не можете начать разговор: дайте партнёру знак одной кнопкой, ' +
        'остыньте и поговорите по шагам. Вы по очереди задаёте друг другу вопросы: свои, из библиотеки или подсказанные ИИ. ' +
        'ИИ не судья и не решает, кто прав. Говорите вы.';
    S.track(payload.startsWith('join_') ? 'start_invited' : 'start');
    await ctx.reply(text, { reply_markup: openBtn(url) });
  });

  // Кнопки-сигналы прямо из чата с ботом: /znak
  bot.command(['znak', 'signal'], async (ctx) => {
    const uid = String(ctx.from.id);
    const user = S.getUser(uid);
    const pair = user?.pairId && S.getPair(user.pairId);
    if (!pair || !S.partnerOf(pair, uid)) return ctx.reply('Сначала создайте пару и пригласите партнёра в игре.', { reply_markup: openBtn(WEBAPP_URL) });
    const kb = new InlineKeyboard();
    for (const [k, g] of Object.entries(G.SIGNALS)) if (!g.hidden) kb.text(`${g.emoji} ${g.label}`, `ss:${k}`).row();
    await ctx.reply('Какой знак отправить партнёру?', { reply_markup: kb });
  });

  // Нажатия на кнопки сигналов в чате: ss — отправить, st — время для «остыть», sr — ответ.
  bot.on('callback_query:data', async (ctx) => {
    const uid = String(ctx.from.id);
    const user = S.getUser(uid);
    const pair = user?.pairId && S.getPair(user.pairId);
    const partnerId = pair && S.partnerOf(pair, uid);
    const [op, a, b, c] = ctx.callbackQuery.data.split(':');
    const done = (text) => ctx.answerCallbackQuery({ text }).catch(() => {});
    if (!partnerId) return done('Сначала пригласите партнёра');
    if (user.safety) return done('Откройте игру');
    if (op === 'ss' && G.SIGNALS[a]) {
      if (G.SIGNALS[a].time) {
        const kb = new InlineKeyboard();
        for (const [k, l] of Object.entries(G.TIMES)) kb.text(l[0].toUpperCase() + l.slice(1), `st:${a}:${k}`).row();
        await ctx.editMessageText('Когда вы вернётесь к разговору?', { reply_markup: kb }).catch(() => {});
        return done();
      }
      sendSignal(pair, user, partnerId, a, '', null);
      await ctx.editMessageText(`Отправлено: ${G.SIGNALS[a].emoji} ${G.SIGNALS[a].label}. Мы скажем, когда ${S.getUser(partnerId)?.name || 'партнёр'} ответит.`).catch(() => {});
      return done('Отправлено');
    }
    if (op === 'st' && G.SIGNALS[a]) {
      sendSignal(pair, user, partnerId, a, '', b);
      await ctx.editMessageText(`Отправлено: ${G.SIGNALS[a].emoji} ${G.SIGNALS[a].label}. Напомним ${G.whenText(b)}.`).catch(() => {});
      return done('Отправлено');
    }
    if (op === 'sm' || op === 'sb') {
      const s = G.find(pair, a);
      if (!s || !s.askMore || timeOwner(s) !== uid) return done('Уже отмечено');
      if (op === 'sm') moreTime(pair, user, s, b); else backNow(pair, user, s);
      await ctx.editMessageText(op === 'sm' ? `Хорошо, напомним ${G.whenText(b)} 🌬` : 'Отлично. Откройте игру, разговор ждёт вас 🕊', op === 'sb' ? { reply_markup: openBtn(WEBAPP_URL) } : undefined).catch(() => {});
      return done('Готово');
    }
    if (op === 'sr') {
      const s = G.find(pair, a);
      const r = s && G.SIGNALS[s.kind].replies[b];
      if (!s || s.to !== uid || s.reply || !r) return done('На этот знак уже ответили');
      if (r.time && !c) {
        const kb = new InlineKeyboard();
        for (const [k, l] of Object.entries(G.TIMES)) kb.text(l[0].toUpperCase() + l.slice(1), `sr:${a}:${b}:${k}`).row();
        await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
        return done('Когда вернётесь к разговору?');
      }
      replySignal(pair, user, s, b, '', c);
      await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
      await ctx.reply(`Ваш ответ: «${r.label}» 🤍`, r.talk || r.step || r.ideas ? { reply_markup: openBtn(WEBAPP_URL, 'Открыть ReadMe 📖') } : undefined);
      return done('Ответ отправлен');
    }
    return done();
  });

  // Голосовой ответ: человек записывает голосовое прямо в чате с ботом,
  // и оно становится ответом на открытый вопрос.
  bot.on('message:voice', async (ctx) => {
    const uid = String(ctx.from.id);
    const user = S.getUser(uid);
    const pair = user?.pairId && S.getPair(user.pairId);
    const open = pair && S.openQuestion(pair.id);
    const canTogether = open?.kind === 'together' && [open.from, open.to].includes(uid) && open.answers?.[uid] == null;
    if (!open || !(open.to === uid || canTogether)) {
      return ctx.reply('Сейчас нет вопроса, на который можно ответить голосом. Когда партнёр задаст вопрос, просто пришлите сюда голосовое 🎙', { reply_markup: new InlineKeyboard().webApp('Открыть ReadMe 📖', WEBAPP_URL) });
    }
    const v = { id: ctx.message.voice.file_id, dur: ctx.message.voice.duration };
    const label = `🎙 Голосовой ответ (${fmtDur(v.dur)})`;
    const partnerId = S.partnerOf(pair, uid);
    if (canTogether) {
      const names = { [uid]: user.name, [partnerId]: S.getUser(partnerId)?.name };
      const { done, q } = S.answerTogether(open.id, uid, label, null, names, v);
      if (done) {
        // Ответы открылись: каждый получает голос другого (если он был голосовым).
        for (const m of [q.from, q.to]) {
          const other = m === q.from ? q.to : q.from;
          if (q.voices?.[other]) sendVoice(m, q.voices[other].id, `🎙 ${S.getUser(other)?.name} ответил(а) на «${q.text}»`);
          notify(m, '👫 Ответы открылись! Посмотрите в игре.');
        }
      } else {
        notify(partnerId, `👫 ${user.name} уже ответил(а) голосом. Ответьте и вы, чтобы услышать друг друга.`);
      }
      return ctx.reply(done ? 'Ответ принят, ответы открылись 👫' : 'Ответ принят и спрятан, пока не ответит партнёр 🙈');
    }
    S.answerQuestion(open.id, label, null, v);
    sendVoice(partnerId, v.id, `🎙 ${user.name} ответил(а) голосом на ваш вопрос «${open.text}»`);
    return ctx.reply('Голосовой ответ отправлен 💌 Теперь ваш ход: откройте ReadMe, чтобы задать вопрос.', { reply_markup: new InlineKeyboard().webApp('Открыть ReadMe 📖', WEBAPP_URL) });
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

async function notify(uid, text, button = 'Открыть 💞') {
  if (!bot || String(uid).startsWith('demo')) return;
  try {
    await bot.api.sendMessage(uid, text, {
      reply_markup: new InlineKeyboard().webApp(button, WEBAPP_URL),
    });
  } catch (e) {
    console.error('notify failed:', e.message);
  }
}

async function notifyKb(uid, text, kb) {
  if (!bot || String(uid).startsWith('demo')) return;
  try { await bot.api.sendMessage(uid, text, { reply_markup: kb }); } catch (e) { console.error('notify failed:', e.message); }
}

// ---------- Кнопки-сигналы ----------
const nameOf = (uid) => S.getUser(uid)?.name || 'Партнёр';
const makeupText = (uid) => {
  const u = S.getUser(uid);
  const list = [...(u?.makeup || []).map((k) => G.MAKEUP[k]).filter(Boolean), u?.makeupOwn].filter(Boolean);
  return list.length ? list.join(', ') : '';
};

function sendSignal(pair, user, partnerId, kind, note, time) {
  const g = G.SIGNALS[kind];
  const s = G.send(pair, user.id, partnerId, kind, note, time);
  S.track(`signal_${kind}`);
  S.touch();
  const body = g.text.replace('{when}', G.whenText(s.time));
  const kb = new InlineKeyboard();
  for (const [k, r] of Object.entries(g.replies)) kb.text(r.label, `sr:${s.id}:${k}`).row();
  kb.webApp('Открыть ReadMe 📖', WEBAPP_URL);
  notifyKb(partnerId, `${g.emoji} ${user.name}:\n\n«${body}»${note ? `\n\n${note}` : ''}`, kb);
  return s;
}

function replySignal(pair, user, s, key, note, time) {
  const g = G.SIGNALS[s.kind];
  const r = G.reply(pair, s, user.id, key, note, time);
  S.track(`reply_${s.kind}_${key}`);
  S.touch();
  let extra = '';
  if (r.minutes || r.time) extra = `\n\nНапомним вам обоим ${G.whenText(r.minutes || s.replyTime)}.`;
  if (s.kind === 'cool' && key === 'tellme') extra = `\n\n${user.name} ждёт, когда вы будете готовы. Напомним вам ${G.whenText(s.time)}.`;
  if (r.solo) extra += '\n\nПока можно подготовиться одному(ой): остыть и спокойно сформулировать, что хотите сказать.';
  if (r.talk) extra = '\n\nОткройте игру: разговор по ступеням ждёт вас обоих.';
  if (r.step) {
    const helps = makeupText(s.from);
    extra = `\n\nВыберите вместе маленький шаг в игре.${helps ? `\n${user.name} помогает помириться: ${helps}.` : ''}`;
  }
  if (r.ideas) extra = `\n\nИдеи на вечер:\n${[...G.IDEAS].sort(() => Math.random() - 0.5).slice(0, 3).map((x) => `• ${x}`).join('\n')}`;
  if (s.kind === 'hurt' && key === 'tell') extra = '\n\nОткройте игру и скажите это своими словами, кнопкой «Сказать».';
  notify(s.from, `${g.emoji} ${user.name} ответил(а) на ваш знак «${g.label}»:\n\n«${r.label}»${note ? `\n${note}` : ''}${extra}`,
    r.solo ? 'Подготовиться одному 🌬' : 'Открыть 💞');
  if (r.talk && !pair.talk) S.track('talk_from_signal');
  return r;
}

// Раз в минуту: напоминания после паузы, тишина после «давай поговорим», напоминание о приглашении.
function signalTick() {
  const now = Date.now();
  let changed = false;
  for (const pair of S.allPairs()) {
    for (const s of pair.signals || []) {
      if (s.remindAt && !s.reminded && now >= s.remindAt) {
        s.reminded = true; s.askMore = true; changed = true;
        // Тот, кто брал время, решает: вернуться или нужно ещё время.
        const owner = timeOwner(s);
        const kb = new InlineKeyboard().text('Готов(а) вернуться', `sb:${s.id}`).row();
        for (const [k, l] of Object.entries(G.TIMES)) kb.text(`Ещё время: ${l}`, `sm:${s.id}:${k}`).row();
        notifyKb(owner, '🕊 Время паузы прошло. Готовы вернуться к разговору или нужно ещё время?', kb);
        const other = owner === s.from ? s.to : s.from;
        if (s.remindWho !== 'from' || other !== s.to) notify(other, `🕊 Пауза закончилась. Спросили ${nameOf(owner)}, готов(а) ли он(а) вернуться к разговору.`, 'Открыть 🕊');
      }
      if (s.kind === 'fight' && !s.reply && !s.silenceNotified && now - s.createdAt > 3 * 3600000) {
        s.silenceNotified = true; changed = true;
        notify(s.from, `Пока тишина от ${nameOf(s.to)}. Хотите пока подготовиться одни: остыть и спокойно сформулировать, что хотите сказать?`, 'Подготовиться 🌬');
      }
    }
    if (pair.members.length === 1 && !pair.inviteNudged && now - pair.createdAt > 86400000) {
      pair.inviteNudged = true; changed = true;
      notify(pair.members[0], 'Партнёр ещё не присоединился к игре. Можно отправить приглашение ещё раз: иногда сообщение просто теряется.', 'Пригласить 💌');
    }
  }
  if (changed) S.touch();
}
setInterval(signalTick, 60 * 1000);

// Кто брал паузу: для «остыть» это отправитель, для ответа «нужно время» — ответивший.
const timeOwner = (s) => (s.kind === 'cool' ? s.from : s.to);

// После напоминания: «готов(а) вернуться» или «нужно ещё время».
function moreTime(pair, user, s, time) {
  s.askMore = false;
  s.time = time in G.TIMES ? time : '60';
  s.remindAt = G.remindTime(s.time); s.reminded = false;
  if (pair.talk?.paused) pair.talk.paused = { by: user.id, until: s.remindAt, when: G.whenText(s.time) };
  S.track('more_time');
  S.touch();
  const other = S.partnerOf(pair, user.id);
  notify(other, `🌬 ${user.name} нужно ещё немного времени. Вернётся к разговору ${G.whenText(s.time)}.`);
}
function backNow(pair, user, s) {
  s.askMore = false;
  if (pair.talk) pair.talk.paused = null;
  S.track('back_after_pause');
  S.touch();
  notify(S.partnerOf(pair, user.id), `🕊 ${user.name} готов(а) вернуться к разговору.`, 'Вернуться 🕊');
}

// Безопасность: если текст тревожный, не отправляем его и показываем человеку помощь.
function unsafe(req, res, ...texts) {
  if (!flagged(...texts)) return false;
  S.updateUser(req.user.id, { safety: Date.now() });
  S.track('safety_stop');
  res.status(422).json({ error: '', safety: true });
  return true;
}

const fmtDur = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

async function sendVoice(uid, fileId, caption) {
  if (!bot || String(uid).startsWith('demo')) return;
  try { await bot.api.sendVoice(uid, fileId, { caption }); } catch (e) { console.error('sendVoice failed:', e.message); }
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
    kind: q.kind || 'ask', why: q.why || null, edited: Boolean(q.edited),
    reply: q.reply || null, replyDone: Boolean(q.replyDone),
    // Ответы вдвоём скрыты, пока не ответили оба: видно только, кто уже ответил.
    answers: q.kind === 'together' && q.answer != null ? q.answers : null,
    // Голос: только признак и длительность; сам файл отдаётся по /api/voice.
    voice: q.voice ? { dur: q.voice.dur } : null,
    voices: q.kind === 'together' && q.answer != null && q.voices
      ? Object.fromEntries(Object.entries(q.voices).map(([k, v]) => [k, { dur: v.dur }])) : null,
    answeredBy: q.kind === 'together' ? Object.keys(q.answers || {}) : null,
    createdAt: q.createdAt, answeredAt: q.answeredAt,
  };
}

// ---------- Разговор по ступеням ----------
// Градус и «легче / тяжелее» каждого видит только он сам: партнёру не отдаём.
function talkView(pair, uid, partner) {
  const t = pair.talk;
  if (!t || !partner) return null;
  const bothHeard = pair.members.every((m) => t.heard[m]);
  return {
    id: t.id, topic: t.topic, stage: t.stage, startedAt: t.startedAt,
    myTemp: t.temps[uid] ?? null, partnerTempSet: t.temps[partner.id] != null,
    questions: S.pairQuestions(pair.id).length - t.qStart,
    heardMine: t.heard[uid] || null, partnerHeard: Boolean(t.heard[partner.id]),
    heard: bothHeard ? t.heard : null, step: t.step,
    repeat: t.repeat || 0, deep: Boolean(t.deep), paused: t.paused && t.paused.until > Date.now() ? { mine: t.paused.by === uid, when: t.paused.when } : null,
  };
}

function lastTalkView(pair, uid, partner) {
  const t = pair.talks?.[0];
  if (!t || !partner) return null;
  return {
    id: t.id, topic: t.topic, endedAt: t.endedAt, questions: t.questions, step: t.step,
    heard: t.heard, myTempStart: t.tempStart[uid] ?? null, myTempEnd: t.temps[uid] ?? null,
    checkDue: Date.now() >= t.checkAt && !t.checks?.[uid],
    checks: t.checks || {},
    partnerHelps: makeupText(partner.id),
  };
}

function talkTick() {
  for (const pair of S.allPairs()) {
    const t = pair.talks?.[0];
    if (!t || t.checkNotified || Date.now() < t.checkAt) continue;
    t.checkNotified = true;
    for (const m of pair.members) {
      notify(m, `🌱 Прошло 3 дня после вашего разговора.${t.step ? `\n\nВы договорились: «${t.step}»` : ''}\n\nПолучается? Отметьте в игре.`, 'Отметить 🌱');
    }
  }
  S.touch();
}

// ---------- Вопрос дня ----------
function dailyView(pair, uid, partner) {
  if (!partner) return null;
  const today = D.localNow().date;
  const d = D.ensureToday(pair, today);
  const both = pair.members.every((m) => d.answers[m] != null);
  const reveal = (x) => ({ date: x.date, text: x.text, answers: pair.members.every((m) => x.answers[m] != null) ? x.answers : null });
  return {
    date: d.date, text: d.text,
    mine: d.answers[uid] ?? null,
    partnerAnswered: d.answers[partner.id] != null,
    // Ответ партнёра виден, только когда ответили оба.
    answers: both ? d.answers : null,
    streak: D.currentStreak(pair, today),
    past: (pair.dailyHistory || []).slice(0, 14).map(reveal),
  };
}

// Раз в 10 минут: после DAILY_HOUR присылаем паре вопрос дня (один раз в день).
function dailyTick() {
  const { date, hour } = D.localNow();
  if (hour < D.DAILY_HOUR) return;
  for (const pair of S.allPairs()) {
    if (pair.members.length !== 2) continue;
    const d = D.ensureToday(pair, date);
    if (d.sent) continue;
    d.sent = true;
    for (const m of pair.members) notify(m, `☀️ Вопрос дня для вас двоих:\n\n«${d.text}»\n\nОтветы откроются, когда ответите оба.`, 'Ответить ☀️');
  }
  S.touch();
}
setInterval(() => { dailyTick(); talkTick(); }, 10 * 60 * 1000);

function signalPublic(s) {
  const g = G.SIGNALS[s.kind];
  return {
    id: s.id, kind: s.kind, emoji: g.emoji, label: g.label, from: s.from, to: s.to,
    text: g.text.replace('{when}', G.whenText(s.time)), note: s.note,
    replies: Object.entries(g.replies).map(([k, r]) => ({ key: k, label: r.label, time: Boolean(r.time) })),
    reply: s.reply, replyLabel: s.reply ? g.replies[s.reply].label : null, replyNote: s.replyNote,
    talk: Boolean(s.reply && g.replies[s.reply].talk), step: Boolean(s.reply && g.replies[s.reply].step),
    ideas: s.reply && g.replies[s.reply].ideas ? G.IDEAS : null,
    stepText: s.step, createdAt: s.createdAt, repliedAt: s.repliedAt,
  };
}

// Последнее примирение за сутки, для которого нужно выбрать маленький шаг.
function recentStep(pair) {
  const s = (pair.signals || []).find((x) => x.reply && G.SIGNALS[x.kind].replies[x.reply].step && Date.now() - x.repliedAt < 86400000);
  return s ? { id: s.id, step: s.step, helps: Object.fromEntries(pair.members.map((m) => [m, makeupText(m)])) } : null;
}

// ---------- API ----------
const app = express();
app.use(express.json({ limit: '50kb' }));
app.use(express.static(path.resolve('public')));
if (bot && USE_WEBHOOK) app.post(`/tg/${HOOK_SECRET}`, webhookCallback(bot, 'express', { secretToken: HOOK_SECRET }));
app.get('/health', (req, res) => res.send('ok'));

app.get('/api/config', (req, res) => res.json({
  demo: DEMO, aiEnabled, tones: TONES, stages: STAGES, topics: TOPICS, voice: Boolean(bot),
  signals: Object.fromEntries(Object.entries(G.SIGNALS).filter(([, g]) => !g.hidden).map(([k, g]) => [k, { emoji: g.emoji, label: g.label, time: Boolean(g.time) }])),
  times: G.TIMES, makeup: G.MAKEUP, help: HELP,
}));

// Простые счётчики воронки: /stats?key=… (ключ задаётся в STATS_KEY).
app.get('/stats', (req, res) => {
  if (!process.env.STATS_KEY || req.query.key !== process.env.STATS_KEY) return res.status(404).end();
  res.json(S.stats());
});

app.use('/api', auth);

app.get('/api/state', (req, res) => {
  const me = req.user;
  const pair = me.pairId && S.getPair(me.pairId);
  const base = {
    me: { id: me.id, name: me.name, tone: me.tone, situation: me.situation, message: me.message || '', makeup: me.makeup ?? null, makeupOwn: me.makeupOwn || '', safety: Boolean(me.safety) },
    aiEnabled,
  };
  if (!pair) return res.json({ ...base, pair: null });

  const partnerId = S.partnerOf(pair, me.id);
  const partner = partnerId && S.getUser(partnerId);
  const users = { [me.id]: me, ...(partner ? { [partner.id]: partner } : {}) };
  const open = S.openQuestion(pair.id);
  const answered = S.pairQuestions(pair.id).filter((q) => q.answer != null);
  // Последний ответ на мой вопрос, на который я ещё не сказал(а) пару слов.
  const last = answered[answered.length - 1];
  const pendingReply = last && last.from === me.id && !last.replyDone ? publicQ(last, users) : null;
  res.json({
    ...base,
    pair: {
      code: pair.code,
      invite: botUsername ? `https://t.me/${botUsername}?start=join_${pair.code}` : null,
      myTurn: pair.turn === me.id && !open,
    },
    // Партнёр видит только имя и выбранный тон. Его «сторона» не передаётся.
    // Посыл партнёра виден: он написан именно для второго.
    partner: partner && { name: partner.name, tone: partner.tone, sideFilled: Boolean(partner.situation), message: partner.message || '' },
    open: open ? publicQ(open, users) : null,
    pendingReply,
    history: answered.map((q) => publicQ(q, users)).reverse(),
    daily: dailyView(pair, me.id, partner),
    talk: talkView(pair, me.id, partner),
    lastTalk: lastTalkView(pair, me.id, partner),
    signals: {
      pending: G.pendingFor(pair, me.id).map((s) => ({ ...signalPublic(s), helps: makeupText(s.from) })),
      mine: G.recentFrom(pair, me.id).map(signalPublic),
      step: recentStep(pair),
      ask: (pair.signals || []).filter((x) => x.askMore && timeOwner(x) === me.id).map((x) => ({ id: x.id }))[0] || null,
    },
    partnerHelps: partner ? makeupText(partner.id) : '',
    letters: S.pairLetters(pair.id).map((l) => ({ ...l, fromName: users[l.from]?.name })).reverse(),
    insights: { me: insights(pair.id, me.id), partner: partner ? insights(pair.id, partner.id) : null },
  });
});

app.post('/api/profile', (req, res) => {
  const { name, tone, situation, message } = req.body;
  if (unsafe(req, res, situation, message)) return;
  const patch = {};
  if (Array.isArray(req.body.makeup)) patch.makeup = req.body.makeup.filter((k) => k in G.MAKEUP);
  if (typeof req.body.makeupOwn === 'string') patch.makeupOwn = req.body.makeupOwn.trim().slice(0, 120);
  if (typeof message === 'string') {
    patch.message = message.trim().slice(0, 600);
    const pair = req.user.pairId && S.getPair(req.user.pairId);
    const partnerId = pair && S.partnerOf(pair, req.user.id);
    if (partnerId && patch.message && patch.message !== req.user.message) {
      notify(partnerId, `💌 ${req.user.name} оставил(а) вам посыл перед разговором. Откройте игру, чтобы прочитать.`);
    }
  }
  if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 40);
  if (tone in TONES) patch.tone = tone;
  if (typeof situation === 'string') patch.situation = situation.slice(0, 4000);
  S.updateUser(req.user.id, patch);
  res.json({ ok: true });
});

app.post('/api/pair/create', (req, res) => {
  if (req.user.pairId) return res.status(400).json({ error: 'Вы уже в паре' });
  S.track('pair_created');
  res.json(S.createPair(req.user.id));
});

app.post('/api/pair/join', (req, res) => {
  if (req.user.pairId) return res.status(400).json({ error: 'Вы уже в паре' });
  try {
    const p = S.joinPair(req.user.id, req.body.code || '');
    S.track('pair_joined');
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

function applyFeel(pair, uid, f) {
  if (!pair.talk || !['better', 'same', 'worse'].includes(f)) return;
  T.feel(pair.talk, uid, f);
  S.touch();
}

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
  const talk = req.user.pairId && S.getPair(req.user.pairId)?.talk;
  // Во время разговора сначала идут вопросы текущей ступени.
  const stageQs = talk ? STAGE_Q[talk.stage][tone].map((text) => ({ text, asked: asked.has(text), stage: talk.stage })) : [];
  // Разговор о теме целиком: сначала вопросы про саму тему.
  if (talk?.deep) stageQs.unshift(...themeQuestions(tone, TOPICS[talk.topic]).map((text) => ({ text, asked: asked.has(text), theme: true })));
  const rest = LIBRARY[tone].filter((t) => !stageQs.some((x) => x.text === t)).map((text) => ({ text, asked: asked.has(text) }));
  res.json({ questions: [...stageQs, ...rest] });
});

app.post('/api/ai/suggest', async (req, res) => {
  const ctx = requireTurn(req, res);
  if (!ctx) return;
  const tone = req.body.tone in TONES ? req.body.tone : ctx.partner.tone || 'gentle';
  const users = { [req.user.id]: req.user, [ctx.partner.id]: ctx.partner };
  const history = S.pairQuestions(ctx.pair.id).map((q) => ({ ...q, fromName: users[q.from]?.name }));
  const talk = ctx.pair.talk;
  const stage = talk ? { ...STAGES[talk.stage], topic: TOPICS[talk.topic], hot: Math.max(0, ...Object.values(talk.temps)) >= 4, deep: Boolean(talk.deep), repeat: talk.repeat || 0 } : null;
  const out = await suggestQuestions({ tone, asker: req.user, receiver: ctx.partner, history, stage });
  res.json(out);
});

app.post('/api/question', (req, res) => {
  const ctx = requireTurn(req, res);
  if (!ctx) return;
  const kind = ['say', 'together'].includes(req.body.kind) ? req.body.kind : 'ask';
  const text = String(req.body.text || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: kind === 'say' ? 'Напишите, что хотите сказать' : 'Пустой вопрос' });
  const tone = req.body.tone in TONES ? req.body.tone : 'gentle';
  const source = kind === 'say' ? 'own' : ['own', 'library', 'ai'].includes(req.body.source) ? req.body.source : 'own';
  const why = String(req.body.why || '').trim().slice(0, 300) || null;
  if (unsafe(req, res, text, why)) return;
  const edited = source !== 'own' && Boolean(req.body.edited);
  const q = S.addQuestion({ pairId: ctx.pair.id, from: req.user.id, to: ctx.partner.id, text, tone, source, kind, why, edited });
  notify(ctx.partner.id, kind === 'say'
    ? `💬 ${req.user.name} хочет вам кое-что сказать. Откройте игру.`
    : kind === 'together'
    ? `👫 ${req.user.name} предлагает ответить на вопрос вдвоём. Ответы откроются, когда ответите оба.`
    : `💌 ${req.user.name} задал(а) вам вопрос. Откройте игру, чтобы ответить.`);
  res.json(q);
});

app.post('/api/answer', (req, res) => {
  const pair = req.user.pairId && S.getPair(req.user.pairId);
  const open = pair && S.openQuestion(pair.id);
  if (open?.kind === 'together' && [open.from, open.to].includes(req.user.id)) {
    if (open.answers?.[req.user.id] != null) return res.status(400).json({ error: 'Вы уже ответили' });
    const text = String(req.body.answer || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ error: 'Напишите ответ' });
    if (unsafe(req, res, text)) return;
    const rating = ['love', 'like', 'meh'].includes(req.body.rating) ? req.body.rating : null;
    const other = open.from === req.user.id ? open.to : open.from;
    const names = { [req.user.id]: req.user.name, [other]: S.getUser(other)?.name };
    const { done } = S.answerTogether(open.id, req.user.id, text, rating, names);
    applyFeel(pair, req.user.id, req.body.feel);
    if (done) {
      if (open.voices?.[other]) sendVoice(req.user.id, open.voices[other].id, `🎙 ${names[other]} ответил(а) на «${open.text}»`);
      notify(other, `👫 Ответы открылись! Посмотрите, что ответил(а) ${req.user.name}.`);
    } else {
      notify(other, `👫 ${req.user.name} уже ответил(а). Ответьте и вы, чтобы увидеть ответы друг друга.`);
    }
    return res.json({ ok: true, done });
  }
  if (!open || open.to !== req.user.id) return res.status(400).json({ error: 'Нет вопроса для ответа' });
  let answer = String(req.body.answer || '').trim().slice(0, 2000);
  if (!answer && open.kind === 'say') answer = '🤍 Я тебя услышал(а)';
  if (!answer) return res.status(400).json({ error: 'Напишите ответ' });
  if (unsafe(req, res, answer)) return;
  const rating = ['love', 'like', 'meh'].includes(req.body.rating) ? req.body.rating : null;
  S.answerQuestion(open.id, answer, rating);
  applyFeel(pair, req.user.id, req.body.feel);
  notify(open.from, `✨ ${req.user.name} ответил(а) вам. Откройте игру, чтобы прочитать.`);
  res.json({ ok: true });
});

// Ответ на ответ: пара слов партнёру после его ответа. Можно пропустить.
app.post('/api/reply', (req, res) => {
  const pair = req.user.pairId && S.getPair(req.user.pairId);
  const q = pair && S.pairQuestions(pair.id).find((x) => x.id === req.body.id);
  if (!q || q.from !== req.user.id || q.answer == null || q.replyDone) return res.status(400).json({ error: 'Нечего отвечать' });
  const text = String(req.body.text || '').trim().slice(0, 600);
  if (unsafe(req, res, text)) return;
  S.replyToAnswer(q.id, text);
  if (text) notify(q.to, `💬 ${req.user.name} откликнулся(ась) на ваш ответ.`);
  res.json({ ok: true });
});

app.post('/api/daily', (req, res) => {
  const pair = req.user.pairId && S.getPair(req.user.pairId);
  const partnerId = pair && S.partnerOf(pair, req.user.id);
  if (!partnerId) return res.status(400).json({ error: 'Сначала пригласите партнёра' });
  const text = String(req.body.answer || '').trim().slice(0, 1000);
  if (!text) return res.status(400).json({ error: 'Напишите ответ' });
  if (unsafe(req, res, text)) return;
  const d = D.ensureToday(pair);
  if (d.answers[req.user.id] != null) return res.status(400).json({ error: 'Вы уже ответили сегодня' });
  const both = D.answerDaily(pair, req.user.id, text);
  S.touch();
  notify(partnerId, both
    ? `☀️ Ответы на вопрос дня открылись! Посмотрите, что ответил(а) ${req.user.name}.`
    : `☀️ ${req.user.name} ответил(а) на вопрос дня. Ответьте и вы, чтобы увидеть ответы друг друга.`, 'Открыть ☀️');
  res.json({ ok: true, both });
});

// Прослушать голосовой ответ в игре: файл берём у Telegram.
app.get('/api/voice/:qid', async (req, res) => {
  const q = S.findQuestion(req.params.qid);
  if (!q || q.pairId !== req.user.pairId || !bot) return res.status(404).end();
  let v = q.voice;
  if (q.kind === 'together') v = q.answer != null ? q.voices?.[req.query.who] : null;
  if (!v) return res.status(404).end();
  try {
    const f = await bot.api.getFile(v.id);
    const r = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${f.file_path}`);
    res.set('Content-Type', 'audio/ogg');
    res.send(Buffer.from(await r.arrayBuffer()));
  } catch (e) {
    console.error('voice fetch failed:', e.message);
    res.status(502).end();
  }
});

function talkCtx(req, res) {
  const pair = req.user.pairId && S.getPair(req.user.pairId);
  const partnerId = pair && S.partnerOf(pair, req.user.id);
  if (!partnerId) { res.status(400).json({ error: 'Сначала пригласите партнёра' }); return null; }
  return { pair, partnerId };
}
const temp = (x) => (Number.isInteger(x) && x >= 1 && x <= 5 ? x : null);

app.post('/api/talk/start', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  if (c.pair.talk) return res.status(400).json({ error: 'Разговор уже идёт' });
  const topic = req.body.topic in TOPICS ? req.body.topic : 'other';
  const t = temp(req.body.temp);
  if (!t) return res.status(400).json({ error: 'Отметьте, насколько сейчас горячо' });
  T.startTalk(c.pair, req.user.id, topic, t, S.pairQuestions(c.pair.id).length);
  const n = repeatCount(c.pair, topic);
  if (n >= REPEAT_AT) c.pair.talk.repeat = n;
  S.track('talk_started');
  S.touch();
  notify(c.partnerId, `🕊 ${req.user.name} начал(а) разговор: «${TOPICS[topic]}». Отметьте, насколько вам сейчас горячо, и начнём с малого.`, 'Присоединиться 🕊');
  res.json({ ok: true });
});

app.post('/api/talk/temp', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  const t = temp(req.body.temp);
  if (!c.pair.talk || !t) return res.status(400).json({ error: 'Нет разговора' });
  T.setTemp(c.pair.talk, req.user.id, t);
  S.touch();
  res.json({ ok: true });
});

app.post('/api/talk/finish', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  if (!c.pair.talk) return res.status(400).json({ error: 'Нет разговора' });
  const heard = String(req.body.heard || '').trim().slice(0, 1000);
  const step = String(req.body.step || '').trim().slice(0, 500);
  if (!heard) return res.status(400).json({ error: 'Напишите, что вы услышали' });
  if (unsafe(req, res, heard, step)) return;
  const done = T.finish(c.pair, req.user.id, heard, step, S.pairQuestions(c.pair.id).length);
  if (done) S.track('talk_finished');
  S.touch();
  notify(c.partnerId, done
    ? '🌿 Разговор завершён. Откройте итог: что вы услышали друг от друга и ваш маленький шаг.'
    : `🌿 ${req.user.name} подводит итог разговора и написал(а), что услышал(а). Напишите и вы, чтобы увидеть итог.`, 'Открыть итог 🌿');
  res.json({ ok: true, done });
});

app.post('/api/talk/cancel', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  c.pair.talk = null;
  S.touch();
  res.json({ ok: true });
});

app.post('/api/talk/check', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  const t = c.pair.talks?.find((x) => x.id === req.body.id);
  const v = ['yes', 'partly', 'no'].includes(req.body.value) ? req.body.value : null;
  if (!t || !v) return res.status(400).json({ error: 'Нет разговора' });
  t.checks = { ...(t.checks || {}), [req.user.id]: v };
  S.touch();
  res.json({ ok: true });
});

// Повторяющаяся тема: пара соглашается поговорить о теме целиком.
app.post('/api/talk/deep', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  if (!c.pair.talk) return res.status(400).json({ error: 'Нет разговора' });
  c.pair.talk.deep = Boolean(req.body.on);
  if (c.pair.talk.deep) { S.track('talk_deep'); notify(c.partnerId, `🔁 ${req.user.name} предлагает поговорить о теме «${TOPICS[c.pair.talk.topic]}» целиком, а не только о последнем случае.`); }
  S.touch();
  res.json({ ok: true });
});

// Отправить знак партнёру.
app.post('/api/signal', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  const kind = req.body.kind;
  if (!(kind in G.SIGNALS)) return res.status(400).json({ error: 'Неизвестный знак' });
  const note = String(req.body.note || '').trim().slice(0, 1000);
  if (kind === 'calm' && !note) return res.status(400).json({ error: 'Напишите сообщение' });
  if (unsafe(req, res, note)) return;
  const s = sendSignal(c.pair, req.user, c.partnerId, kind, note, req.body.time);
  // «Остыть» посреди разговора ставит его на паузу; ответы и ступень сохраняются.
  if (kind === 'cool' && c.pair.talk) c.pair.talk.paused = { by: req.user.id, until: s.remindAt, when: G.whenText(s.time) };
  S.touch();
  res.json({ ok: true, id: s.id });
});

app.post('/api/signal/reply', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  const s = G.find(c.pair, req.body.id);
  if (!s || s.to !== req.user.id || s.reply || !G.SIGNALS[s.kind].replies[req.body.reply]) return res.status(400).json({ error: 'На этот знак уже ответили' });
  const note = String(req.body.note || '').trim().slice(0, 600);
  if (unsafe(req, res, note)) return;
  const r = replySignal(c.pair, req.user, s, req.body.reply, note, req.body.time);
  res.json({ ok: true, talk: Boolean(r.talk), step: Boolean(r.step), ideas: r.ideas ? G.IDEAS : null });
});

// Маленький шаг после примирения: любой из двоих пишет или правит.
app.post('/api/signal/step', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  const s = G.find(c.pair, req.body.id);
  const step = String(req.body.step || '').trim().slice(0, 300);
  if (!s || !step) return res.status(400).json({ error: 'Напишите маленький шаг' });
  if (unsafe(req, res, step)) return;
  s.step = step;
  S.track('makeup_step');
  S.touch();
  notify(c.partnerId, `🤝 Ваш маленький шаг к примирению: «${step}»`);
  res.json({ ok: true });
});

// После напоминания: вернуться или взять ещё время.
app.post('/api/signal/more', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  const s = G.find(c.pair, req.body.id);
  if (!s || !s.askMore || timeOwner(s) !== req.user.id) return res.status(400).json({ error: 'Уже отмечено' });
  if (req.body.back) backNow(c.pair, req.user, s); else moreTime(c.pair, req.user, s, req.body.time);
  res.json({ ok: true });
});

// Снять паузу разговора раньше времени.
app.post('/api/talk/resume', (req, res) => {
  const c = talkCtx(req, res); if (!c) return;
  if (c.pair.talk) c.pair.talk.paused = null;
  for (const s of c.pair.signals || []) if (s.kind === 'cool' && !s.reminded) s.reminded = true;
  S.touch();
  notify(c.partnerId, `🕊 ${req.user.name} готов(а) вернуться к разговору.`, 'Вернуться 🕊');
  res.json({ ok: true });
});

// «Я в безопасности»: человек сам возвращается в игру после остановки.
app.post('/api/safety/ok', (req, res) => {
  S.updateUser(req.user.id, { safety: null });
  res.json({ ok: true });
});

// Письмо партнёру: личное послание в любой момент, например в конце разговора.
app.post('/api/letter', (req, res) => {
  const pair = req.user.pairId && S.getPair(req.user.pairId);
  const partnerId = pair && S.partnerOf(pair, req.user.id);
  if (!partnerId) return res.status(400).json({ error: 'Сначала пригласите партнёра' });
  const text = String(req.body.text || '').trim().slice(0, 3000);
  if (!text) return res.status(400).json({ error: 'Письмо пустое' });
  if (unsafe(req, res, text)) return;
  const l = S.addLetter({ pairId: pair.id, from: req.user.id, to: partnerId, text });
  notify(partnerId, `✉️ ${req.user.name} написал(а) вам письмо. Откройте игру, чтобы прочитать.`);
  res.json(l);
});

try {
  await S.initStore();
} catch (e) {
  console.error('ОШИБКА подключения к базе (проверьте DATABASE_URL):', e.message);
  delete process.env.DATABASE_URL;
  await S.initStore();
}
setTimeout(() => { dailyTick(); talkTick(); signalTick(); }, 5000);
app.listen(PORT, () => {
  console.log(`Мини-приложение: http://localhost:${PORT}  (демо-режим: ${DEMO ? 'да' : 'нет'}, ИИ: ${aiEnabled ? 'Claude' : 'библиотека'})`);
});
