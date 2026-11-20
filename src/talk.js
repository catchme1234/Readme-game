// Разговор по ступеням: от «остыть» до «маленького шага», с итогом и проверкой через 3 дня.
import crypto from 'node:crypto';

export const CHECK_AFTER = Number(process.env.TALK_CHECK_DAYS || 3) * 86400000;

export function startTalk(pair, uid, topic, temp, questionsSoFar) {
  pair.talk = {
    id: crypto.randomBytes(6).toString('hex'), topic, startedAt: Date.now(), startedBy: uid,
    stage: 1, sameCount: 0, temps: { [uid]: temp }, tempStart: { [uid]: temp },
    qStart: questionsSoFar, heard: {}, step: '', stepBy: null,
  };
  return pair.talk;
}

export function setTemp(talk, uid, temp) {
  talk.temps[uid] = temp;
  talk.tempStart[uid] ??= temp;
}

const hot = (talk) => Math.max(0, ...Object.values(talk.temps)) >= 4;

// После ответа: «легче» ведёт на ступень дальше, «тяжелее» на шаг назад.
// Пока у кого-то градус 4–5, дальше «Чувств» не идём.
export function feel(talk, uid, f) {
  const t = talk.temps[uid];
  if (f === 'better') {
    if (t) talk.temps[uid] = Math.max(1, t - 1);
    talk.sameCount = 0;
    if (!(hot(talk) && talk.stage >= 2)) talk.stage = Math.min(5, talk.stage + 1);
  } else if (f === 'worse') {
    if (t) talk.temps[uid] = Math.min(5, t + 1);
    talk.sameCount = 0;
    talk.stage = Math.max(1, talk.stage - 1);
  } else {
    talk.sameCount += 1;
    if (talk.sameCount >= 2 && !(hot(talk) && talk.stage >= 2)) { talk.stage = Math.min(5, talk.stage + 1); talk.sameCount = 0; }
  }
}

// Итог: каждый пишет, что услышал; шаг общий. Когда оба написали, разговор завершён.
export function finish(pair, uid, heard, step, questionsNow) {
  const talk = pair.talk;
  if (heard) talk.heard[uid] = heard;
  if (step) { talk.step = step; talk.stepBy = uid; }
  const done = pair.members.every((m) => talk.heard[m]);
  if (done) {
    talk.endedAt = Date.now();
    talk.questions = questionsNow - talk.qStart;
    talk.checkAt = talk.endedAt + CHECK_AFTER;
    talk.checks = {};
    pair.talks = [talk, ...(pair.talks || [])].slice(0, 30);
    pair.talk = null;
  }
  return done;
}
