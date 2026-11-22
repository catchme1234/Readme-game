// «Инструкция ко мне»: каждый в спокойный день пишет о себе несколько строк.
// Партнёр видит их, а в ссоре игра показывает ему одну подходящую строчку.
export const MANUAL = [
  { k: 'calm', q: 'Когда я злюсь, мне помогает', hint: 'Например: побыть 20 минут одной, а потом обняться' },
  { k: 'hurt', q: 'Сильнее всего меня задевает', hint: 'Например: когда ты уходишь посреди разговора' },
  { k: 'need', q: 'В ссоре мне важно услышать от тебя', hint: 'Например: «я рядом, даже если мы спорим»' },
  { k: 'sign', q: 'Понять, что я хочу мириться, можно так', hint: 'Например: я ставлю чайник на двоих' },
];

export function cleanManual(m) {
  const out = {};
  for (const { k } of MANUAL) {
    const v = typeof m?.[k] === 'string' ? m[k].trim().slice(0, 300) : '';
    if (v) out[k] = v;
  }
  return out;
}

// «Тайная кнопка мира»: нажатие живёт 3 дня, совпадение показываем 2 дня.
export const PEACE_TTL = 3 * 86400000;
export const MATCH_TTL = 2 * 86400000;

export function pressPeace(pair, uid, on, now = Date.now()) {
  pair.peace ??= {};
  for (const [m, t] of Object.entries(pair.peace)) if (now - t > PEACE_TTL) delete pair.peace[m];
  if (!on) { delete pair.peace[uid]; return false; }
  pair.peace[uid] = now;
  const matched = pair.members.length === 2 && pair.members.every((m) => pair.peace[m]);
  if (matched) { pair.peace = {}; pair.peaceMatch = { at: now, seen: {} }; }
  return matched;
}

export function peaceView(pair, uid, now = Date.now()) {
  const t = pair.peace?.[uid];
  const m = pair.peaceMatch;
  return {
    mine: Boolean(t && now - t <= PEACE_TTL),
    match: m && now - m.at <= MATCH_TTL && !m.seen?.[uid] ? m.at : null,
  };
}
