// Простое хранилище в JSON-файле. Для MVP этого достаточно;
// при росте можно заменить на SQLite/Postgres без изменения API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const FILE = process.env.DATA_FILE || path.resolve('data/db.json');

let db = { users: {}, pairs: {}, questions: [], letters: [] };

// Если задан DATABASE_URL (например, бесплатный Neon Postgres), данные живут там:
// бесплатный хостинг стирает файлы при перезапуске. Иначе используется локальный файл.
let pool = null;
export async function initStore() {
  if (process.env.DATABASE_URL) {
    const { default: pg } = await import('pg');
    const local = /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL);
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
    await pool.query('CREATE TABLE IF NOT EXISTS app_state (id int PRIMARY KEY, data jsonb NOT NULL)');
    const r = await pool.query('SELECT data FROM app_state WHERE id = 1');
    if (r.rows[0]) db = r.rows[0].data;
    console.log('Хранилище: Postgres');
  } else if (fs.existsSync(FILE)) {
    db = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  }
  db.letters ??= [];
}

let saveTimer = null;
let saving = Promise.resolve();
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const snapshot = JSON.stringify(db);
    if (pool) {
      saving = saving.then(() => pool.query(
        'INSERT INTO app_state (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data',
        [snapshot],
      )).catch((e) => console.error('DB save failed:', e.message));
      return;
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE + '.tmp', snapshot);
    fs.renameSync(FILE + '.tmp', FILE);
  }, 50);
}

const id = () => crypto.randomBytes(8).toString('hex');
const code = () => crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);

export function upsertUser(uid, name) {
  const u = db.users[uid] || { id: uid, name, pairId: null, tone: null, situation: '' };
  if (name) u.name = name;
  db.users[uid] = u;
  save();
  return u;
}

export const getUser = (uid) => db.users[uid] || null;
export const getPair = (pid) => db.pairs[pid] || null;

export function updateUser(uid, patch) {
  Object.assign(db.users[uid], patch);
  save();
  return db.users[uid];
}

export function createPair(uid) {
  const p = { id: id(), code: code(), members: [uid], turn: uid, createdAt: Date.now() };
  db.pairs[p.id] = p;
  db.users[uid].pairId = p.id;
  save();
  return p;
}

export function joinPair(uid, inviteCode) {
  const p = Object.values(db.pairs).find((x) => x.code === String(inviteCode).toUpperCase());
  if (!p) throw new Error('Код не найден');
  if (p.members.includes(uid)) return p;
  if (p.members.length >= 2) throw new Error('В этой паре уже двое');
  p.members.push(uid);
  db.users[uid].pairId = p.id;
  save();
  return p;
}

export function leavePair(uid) {
  const u = db.users[uid];
  const p = u && db.pairs[u.pairId];
  if (p) {
    p.members = p.members.filter((m) => m !== uid);
    if (p.members.length === 0) {
      delete db.pairs[p.id];
      db.questions = db.questions.filter((q) => q.pairId !== p.id);
      db.letters = db.letters.filter((l) => l.pairId !== p.id);
    } else p.turn = p.members[0];
  }
  if (u) { u.pairId = null; u.situation = ''; u.message = ''; }
  save();
}

export const partnerOf = (p, uid) => p.members.find((m) => m !== uid) || null;

export const pairQuestions = (pid) => db.questions.filter((q) => q.pairId === pid);
export const openQuestion = (pid) => db.questions.find((q) => q.pairId === pid && q.answer == null);

export function addQuestion(q) {
  const full = { id: id(), createdAt: Date.now(), answer: null, rating: null, answeredAt: null, ...q };
  db.questions.push(full);
  save();
  return full;
}

export function answerQuestion(qid, answer, rating) {
  const q = db.questions.find((x) => x.id === qid);
  q.answer = answer;
  q.rating = rating;
  q.answeredAt = Date.now();
  // Ход переходит к тому, кто ответил: теперь он задаёт вопрос.
  db.pairs[q.pairId].turn = q.to;
  save();
  return q;
}

// Ответ на ответ: задавший вопрос пишет партнёру пару слов о его ответе (или пропускает).
export function replyToAnswer(qid, text) {
  const q = db.questions.find((x) => x.id === qid);
  q.reply = text || null;
  q.replyDone = true;
  save();
  return q;
}

// Письма партнёру: короткие личные послания, видны обоим.
export const pairLetters = (pid) => db.letters.filter((l) => l.pairId === pid);
export function addLetter(l) {
  const full = { id: id(), createdAt: Date.now(), ...l };
  db.letters.push(full);
  save();
  return full;
}

// «Отвечаем вдвоём»: оба отвечают на один вопрос, ответы открываются, только когда ответили оба.
export function answerTogether(qid, uid, text, rating, names) {
  const q = db.questions.find((x) => x.id === qid);
  q.answers ??= {};
  q.answers[uid] = text;
  if (uid === q.to && rating) q.rating = rating;
  const done = [q.from, q.to].every((m) => q.answers[m] != null);
  if (done) {
    q.answer = [q.from, q.to].map((m) => `${names[m] || ''}: ${q.answers[m]}`).join('\n');
    q.answeredAt = Date.now();
    q.replyDone = true;
    db.pairs[q.pairId].turn = q.to;
  }
  save();
  return { q, done };
}

// Сохранить изменения пары, сделанные снаружи (например, вопрос дня).
export function touch() { save(); }
export const allPairs = () => Object.values(db.pairs);
