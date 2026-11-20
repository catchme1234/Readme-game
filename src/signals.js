// Кнопки-сигналы: один партнёр одним нажатием даёт знак другому
// («мы поссорились», «мне нужно остыть», «хочу помириться»…), второй отвечает кнопкой.
import crypto from 'node:crypto';

// time: ответ требует выбрать, когда вернуться к разговору.
// talk: ответ открывает разговор по ступеням.
export const SIGNALS = {
  fight: {
    emoji: '🕊', label: 'Мы поссорились, давай поговорим',
    text: 'Мне важно поговорить о том, что случилось. Когда будешь готов(а)?',
    replies: {
      now: { label: 'Давай сейчас', talk: true },
      hour: { label: 'Через час', minutes: 60 },
      evening: { label: 'Вечером', minutes: 'evening' },
      cool: { label: 'Мне пока нужно остыть', time: true, solo: true },
    },
  },
  cool: {
    emoji: '🌬', label: 'Мне нужно остыть', time: true,
    text: 'Мне нужно немного времени. Я не ухожу, я вернусь к разговору {when}.',
    replies: {
      ok: { label: 'Хорошо, жду' },
      tellme: { label: 'Напиши, когда будешь готов(а)' },
    },
  },
  hurt: {
    emoji: '🥀', label: 'Мне обидно',
    text: 'Мне сейчас обидно. Хочу, чтобы ты знал(а).',
    replies: {
      tell: { label: 'Расскажи, что случилось' },
      sorry: { label: 'Мне жаль, давай поговорим', talk: true },
      hard: { label: 'Мне тоже непросто' },
    },
  },
  makeup: {
    emoji: '🤝', label: 'Хочу помириться',
    text: 'Я хочу помириться.',
    replies: {
      metoo: { label: 'Я тоже', step: true },
      talkfirst: { label: 'Да, но сначала поговорим', talk: true },
      later: { label: 'Мне нужно ещё время', time: true },
    },
  },
  sorry: {
    emoji: '🙏', label: 'Прости меня',
    text: 'Прости меня.',
    replies: {
      forgive: { label: 'Прощаю', step: true },
      thanks: { label: 'Спасибо, мне важно это услышать' },
      later: { label: 'Мне нужно время', time: true },
    },
  },
  miss: {
    emoji: '🫶', label: 'Мне тебя не хватает',
    text: 'Мне тебя не хватает.',
    replies: {
      metoo: { label: 'Мне тебя тоже' },
      together: { label: 'Давай проведём время вместе', ideas: true },
      hug: { label: 'Обнимаю' },
    },
  },
  thanks: {
    emoji: '🌷', label: 'Спасибо тебе',
    text: 'Хочу сказать спасибо.',
    replies: {
      pleased: { label: 'Мне приятно' },
      back: { label: 'И тебе спасибо' },
    },
  },
  // Не кнопка, а итог «начать одному»: спокойное сообщение, подготовленное наедине с ботом.
  calm: {
    emoji: '💌', label: 'Спокойное сообщение', hidden: true,
    text: 'Я подумал(а) наедине и хочу сказать спокойно:',
    replies: {
      talk: { label: 'Давай поговорим', talk: true },
      later: { label: 'Мне нужно время', time: true },
    },
  },
};

export const TIMES = { 20: 'через 20 минут', 60: 'через час', evening: 'вечером', tomorrow: 'завтра' };

// Чем помогает помириться: каждый отмечает о себе, партнёр видит.
export const MAKEUP = {
  hug: '🤗 Обнять',
  words: '💬 Услышать «прости» словами',
  space: '🌙 Побыть немного одному(ой)',
  together: '🚶 Сделать что-то вместе',
  message: '📩 Получить тёплое сообщение',
  care: '🍵 Маленькая забота: чай, ужин, помощь',
};

export const IDEAS = [
  'Прогулка вдвоём без телефонов, хотя бы 30 минут',
  'Приготовить ужин вместе по новому рецепту',
  'Фильм, который выбирает тот, кто скучал',
  'Вспомнить и пересмотреть ваши старые фото',
  'Сходить туда, где вы были на одном из первых свиданий',
  'Настольная игра или карты, проигравший делает чай',
];

// Время напоминания в часовом поясе игры (по умолчанию Москва).
export function remindTime(t, tzOffsetMin = 180) {
  const now = Date.now();
  if (t === 20 || t === '20') return now + 20 * 60000;
  if (t === 60 || t === '60') return now + 60 * 60000;
  const local = new Date(now + tzOffsetMin * 60000);
  const at = (days, hour) => {
    const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + days, hour));
    return d.getTime() - tzOffsetMin * 60000;
  };
  if (t === 'evening') {
    const e = at(0, 20);
    return e > now + 30 * 60000 ? e : now + 60 * 60000;
  }
  if (t === 'tomorrow') return at(1, 10);
  return now + 60 * 60000;
}

export const whenText = (t) => TIMES[t] || 'чуть позже';

export function send(pair, from, to, kind, note, time) {
  pair.signals ??= [];
  const s = {
    id: crypto.randomBytes(6).toString('hex'), kind, from, to, note: note || '',
    createdAt: Date.now(), reply: null, replyNote: '', repliedAt: null, step: '',
  };
  if (SIGNALS[kind].time) { s.time = time in TIMES ? time : '60'; s.remindAt = remindTime(s.time); s.remindWho = 'both'; }
  pair.signals = [s, ...pair.signals].slice(0, 50);
  return s;
}

export function reply(pair, s, uid, key, note, time) {
  const r = SIGNALS[s.kind].replies[key];
  s.reply = key;
  s.replyNote = note || '';
  s.repliedAt = Date.now();
  if (r.minutes) { s.remindAt = remindTime(r.minutes); s.remindWho = 'both'; s.reminded = false; }
  if (r.time) { s.replyTime = time in TIMES ? time : '60'; s.remindAt = remindTime(s.replyTime); s.remindWho = 'both'; s.reminded = false; }
  if (s.kind === 'cool' && key === 'tellme') s.remindWho = 'from';
  return r;
}

export const find = (pair, sid) => (pair.signals || []).find((x) => x.id === sid) || null;

// Сигналы, на которые этот человек ещё не ответил (не старше двух суток).
export const pendingFor = (pair, uid) =>
  (pair.signals || []).filter((s) => s.to === uid && !s.reply && Date.now() - s.createdAt < 2 * 86400000);

// Мои недавние сигналы: чтобы видеть «ждём ответа» и ответ партнёра (сутки).
export const recentFrom = (pair, uid) =>
  (pair.signals || []).filter((s) => s.from === uid && Date.now() - (s.repliedAt || s.createdAt) < 86400000).slice(0, 3);
