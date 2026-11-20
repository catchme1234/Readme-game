// Вопрос дня: лёгкий вопрос паре каждый день, не только в ссоре.
// Оба отвечают, ответы открываются, когда ответили оба. Серия считает дни подряд.

export const DAILY = [
  'Что сегодня было самым приятным за день?',
  'Какой запах напоминает тебе о нас?',
  'Какую мелочь я сделал(а) недавно, а ты заметил(а)?',
  'Куда бы ты хотел(а) поехать вдвоём, если бы деньги не были вопросом?',
  'Какая песня у тебя сейчас в голове?',
  'Что тебя сегодня рассмешило?',
  'Какое блюдо ты хочешь, чтобы мы приготовили вместе?',
  'Какое наше первое воспоминание ты помнишь лучше всего?',
  'Чему ты хотел(а) бы научиться в этом году?',
  'Что бы ты делал(а) в идеальное воскресенье?',
  'За что ты сегодня благодарен(на)?',
  'Какой фильм ты готов(а) пересматривать бесконечно?',
  'Какая моя привычка тебя умиляет?',
  'Если бы у нас был дом мечты, какая в нём была бы одна необычная комната?',
  'Что тебя сейчас немного тревожит, пусть даже мелочь?',
  'Какой комплимент ты слышал(а) и до сих пор помнишь?',
  'Какую нашу традицию ты бы хотел(а) начать?',
  'Чем ты гордишься на этой неделе?',
  'Какое время года больше похоже на тебя и почему?',
  'Что бы ты сказал(а) себе десятилетнему(ей)?',
  'Какой у тебя сегодня уровень энергии от 1 до 10?',
  'Что я могу сделать завтра, чтобы твой день стал чуть лучше?',
  'Какой подарок из детства ты помнишь до сих пор?',
  'Какое животное ты бы завёл(а), если бы можно было любое?',
  'Где тебе спокойнее всего?',
  'Какую книгу или сериал ты бы посоветовал(а) мне прямо сейчас?',
  'Что в нашей жизни сейчас тебе особенно нравится?',
  'Какой суперспособностью ты бы хотел(а) обладать на один день?',
  'О чём ты мечтал(а) в детстве стать?',
  'Какое слово описывает твой сегодняшний день?',
  'Что ты хочешь, чтобы мы сделали вместе этим летом?',
  'Какой самый смешной случай был у нас вдвоём?',
  'Что тебя вдохновляет в последнее время?',
  'Какой маленький ритуал делает твоё утро лучше?',
  'Если бы ты мог(ла) сегодня взять выходной, как бы ты его провёл(а)?',
  'Что ты обо мне узнал(а) в последнее время?',
  'Какое место из детства ты хотел(а) бы мне показать?',
  'Что тебе сейчас нужно больше: тишина, разговор или объятия?',
  'Какой звук тебя успокаивает?',
  'Что бы ты хотел(а), чтобы я чаще говорил(а) тебе?',
];

const TZ = process.env.DAILY_TZ || 'Europe/Moscow';
const HOUR = Number(process.env.DAILY_HOUR || 10);

// Дата и час в часовом поясе игры.
export function localNow(d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

const dayNumber = (date) => Math.floor(Date.parse(date + 'T00:00:00Z') / 86400000);
const prevDate = (date) => new Date(Date.parse(date + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);

// Сегодняшний вопрос пары: у каждой пары свой порядок, без повторов, пока список не кончится.
export function questionFor(pair, date) {
  let h = 0;
  for (const c of pair.id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return DAILY[(dayNumber(date) + h) % DAILY.length];
}

// Обновить «вопрос дня» в паре на сегодня (переносит вчерашний в историю).
export function ensureToday(pair, date = localNow().date) {
  if (pair.daily?.date === date) return pair.daily;
  if (pair.daily && Object.keys(pair.daily.answers || {}).length) {
    pair.dailyHistory = [pair.daily, ...(pair.dailyHistory || [])].slice(0, 60);
  }
  pair.daily = { date, text: questionFor(pair, date), answers: {}, sent: false };
  return pair.daily;
}

// Ответ на вопрос дня. Возвращает true, если теперь ответили оба.
export function answerDaily(pair, uid, text, date = localNow().date) {
  const d = ensureToday(pair, date);
  d.answers[uid] = text;
  const both = pair.members.length === 2 && pair.members.every((m) => d.answers[m] != null);
  if (both && pair.streakDate !== date) {
    pair.streak = pair.streakDate === prevDate(date) ? (pair.streak || 0) + 1 : 1;
    pair.streakDate = date;
  }
  return both;
}

// Серия жива, если оба ответили сегодня или вчера.
export function currentStreak(pair, date = localNow().date) {
  if (!pair.streakDate) return 0;
  return pair.streakDate === date || pair.streakDate === prevDate(date) ? pair.streak || 0 : 0;
}

export const DAILY_HOUR = HOUR;
