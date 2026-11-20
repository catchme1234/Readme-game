const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg?.initData);
if (inTelegram) {
  tg.ready(); tg.expand(); document.documentElement.classList.add('tg');
  try { tg.setHeaderColor('#FAF5ED'); tg.setBackgroundColor('#FAF5ED'); tg.setBottomBarColor?.('#FAF5ED'); } catch {}
}

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let config = { tones: {} };
let S = null;            // состояние с сервера
let lastJson = '';
let tab = 'game';
let demoUser = localStorageGet('demoUser') || 'demoA';
// Черновики живут здесь, чтобы обновления не стирали набранный текст.
const freshCompose = (mode = 'own') => ({ mode, tone: null, text: '', picked: null, suggestions: null, loading: false, source: 'own', why: '', together: false });
let compose = freshCompose();
let replyDraft = '';
let letterDraft = null;   // null — форма письма закрыта
let msgDraft = null;
let dailyDraft = '';
let feelPick = null;          // «легче / так же / тяжелее» после ответа
let talkForm = null;          // { topic, temp } — форма начала разговора
let summary = null;           // { heard, step } — форма итога

const TEMP_LABEL = ['', 'спокойно', 'чуть напряжённо', 'горячо', 'очень горячо', 'кипит'];

// Полоска ступеней разговора и свой градус.
function talkBar() {
  const t = S.talk;
  if (!t) return '';
  const st = config.stages[t.stage];
  const ready = t.stage >= 5 || t.questions >= 8;
  return `<div class="card talk">
    <div class="row" style="justify-content:space-between;align-items:baseline"><b>🕊 ${esc(config.topics[t.topic])}</b><span class="muted">${t.questions} ${plural(t.questions, 'вопрос', 'вопроса', 'вопросов')}</span></div>
    <div class="steps">${[1, 2, 3, 4, 5].map((n) => `<i class="${n < t.stage ? 'd' : n === t.stage ? 'now' : ''}"></i>`).join('')}</div>
    <p style="margin:6px 0 0"><b>Ступень ${t.stage}: ${esc(st.label)}.</b> <span class="muted">${esc(st.hint)}.</span></p>
    ${t.myTemp == null
      ? `<p style="margin:12px 0 6px"><b>Насколько вам сейчас горячо?</b> <span class="muted">Видите только вы.</span></p>${tempChips(null, 'settemp')}`
      : `<p class="muted" style="margin:10px 0 0">Мой градус: ${t.myTemp} · ${TEMP_LABEL[t.myTemp]} <span>(видите только вы)</span> · <a href="#" data-retemp>изменить</a></p>`}
    ${!t.partnerTempSet ? `<p class="muted" style="margin:6px 0 0">${esc(S.partner.name)} ещё не отметил(а) свой градус.</p>` : ''}
    ${t.partnerHeard ? `<p style="margin:10px 0 0"><b>${esc(S.partner.name)} уже подводит итог и ждёт вас.</b></p>` : ''}
    ${t.paused ? `<div class="pause"><b>🌬 Пауза.</b> ${t.paused.mine ? 'Вы' : esc(S.partner.name)} остываете, вернётесь ${esc(t.paused.when)}. Всё сказанное сохранено.${t.paused.mine ? '<button class="ghost" data-resume style="margin-top:8px">Я готов(а) продолжить</button>' : ''}</div>` : ''}
    ${t.repeat && !t.deep ? `<div class="repeat"><b>🔁 Это уже ${t.repeat}-й разговор про «${esc(config.topics[t.topic].toLowerCase())}».</b> Хотите поговорить о теме целиком, а не только о последнем случае? <button data-deep="1" style="margin-top:8px">Да, о теме целиком</button></div>` : ''}
    ${t.deep ? '<p class="muted" style="margin:8px 0 0">🔁 Говорим о теме целиком: первыми в библиотеке идут вопросы про саму тему.</p>' : ''}
    <button class="${ready || t.partnerHeard ? '' : 'ghost'}" data-summary style="margin-top:12px">🌿 Подвести итог</button>
    ${t.paused ? '' : '<button class="ghost" data-sigopen="cool">🌬 Мне нужно остыть</button>'}
  </div>`;
}

function tempChips(cur, attr) {
  return `<div class="temps">${[1, 2, 3, 4, 5].map((n) => `<button data-${attr}="${n}" class="t${n} ${cur === n ? 'on' : ''}">${n}</button>`).join('')}</div>
    <p class="muted" style="margin:4px 0 0;font-size:12px">1 — спокойно, 5 — кипит</p>`;
}

function startTalkCard() {
  if (S.talk) return '';
  if (!talkForm) {
    return `<div class="card talk"><b>🕊 Застряли в споре?</b>
      <p class="muted" style="margin:6px 0 10px">Начните разговор по ступеням: от «остыть» до «маленького шага». Вопросы будут подбираться под то, где вы сейчас.</p>
      <button class="ghost" data-talkopen>Начать разговор</button></div>`;
  }
  return `<div class="card talk"><h2>🕊 Новый разговор</h2>
    <p><b>О чём тупик?</b></p>
    <div class="chips">${Object.entries(config.topics).map(([k, l]) => `<button class="chip ${talkForm.topic === k ? 'on' : ''}" data-topic="${k}">${esc(l)}</button>`).join('')}</div>
    <p><b>Насколько вам сейчас горячо?</b> <span class="muted">Видите только вы.</span></p>
    ${tempChips(talkForm.temp, 'formtemp')}
    <div class="row" style="margin-top:12px"><button data-talkstart>Начать</button><button class="ghost" data-talkclose>Отмена</button></div>
  </div>`;
}

function feelChips() {
  if (!S.talk) return '';
  const opts = { better: '🙂 Легче', same: '😐 Так же', worse: '😣 Тяжелее' };
  return `<p class="muted" style="margin-top:12px">А как вам сейчас? <span>(видите только вы, это помогает подобрать следующий вопрос)</span></p>
    <div class="rating">${Object.entries(opts).map(([k, l]) => `<button data-feel="${k}" class="${feelPick === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
}

function lastTalkCard() {
  const t = S.lastTalk;
  if (!t || S.talk) return '';
  const fresh = Date.now() - t.endedAt < 2 * 86400000;
  if (!fresh && !t.checkDue) return '';
  const heard = Object.entries(t.heard).sort(([a]) => (a === S.me.id ? -1 : 1))
    .map(([m, h]) => `<p style="margin:4px 0"><b>${m === S.me.id ? 'Вы' : esc(S.partner.name)} услышали:</b> ${esc(h)}</p>`).join('');
  const check = t.checkDue ? `
    <div class="sep"></div><b>🌱 Прошло 3 дня. Получается?</b>
    <div class="rating" style="margin-top:8px"><button data-check="yes">👍 Да</button><button data-check="partly">🤏 Частично</button><button data-check="no">👎 Не очень</button></div>` : '';
  return `<div class="card warm"><p class="muted">🌿 Итог разговора «${esc(config.topics[t.topic])}» · ${t.questions} ${plural(t.questions, 'вопрос', 'вопроса', 'вопросов')}${t.myTempStart ? ` · ваш градус ${t.myTempStart} → ${t.myTempEnd}` : ''}</p>
    ${heard}
    ${t.step ? `<p style="margin:10px 0 0"><b>Наш маленький шаг:</b> ${esc(t.step)}</p>` : ''}
    ${t.partnerHelps ? `<p class="muted" style="margin:10px 0 0">🤍 ${esc(S.partner.name)} помогает помириться: ${esc(t.partnerHelps)}</p>` : ''}
    ${check}
  </div>`;
}

function renderSummary() {
  const t = S.talk;
  summary ??= { heard: '', step: t.step || '' };
  const waiting = t.heardMine && !t.heard;
  $app.innerHTML = `
    <div class="card warm"><h1>🌿 Итог разговора</h1>
      <p class="muted">${t.questions} ${plural(t.questions, 'вопрос', 'вопроса', 'вопросов')} · ${esc(config.topics[t.topic])}</p></div>
    ${waiting ? `
      <div class="card"><p class="muted">Вы написали:</p><div class="msgtext">${esc(t.heardMine)}</div></div>
      <div class="card hero"><div class="big">🙈</div><h1>Ждём ${esc(S.partner.name)}</h1>
        <p class="muted">Итог откроется, когда ${esc(S.partner.name)} тоже напишет, что услышал(а).</p></div>
      <button class="ghost" data-summaryclose>Вернуться к вопросам</button>` : `
    <div class="card">
      <h2>Что я услышал(а)</h2>
      <p class="muted">Одной-двумя фразами, своими словами. ${esc(S.partner.name)} увидит это, когда тоже напишет.</p>
      <textarea id="heard" maxlength="1000" placeholder="Я услышал(а), что тебе…">${esc(summary.heard)}</textarea>
      <h2 style="margin-top:14px">Наш маленький шаг</h2>
      <p class="muted">Одно конкретное действие. Через 3 дня бот спросит у вас обоих, получается ли.${t.step ? ' Можно поправить то, что предложил(а) партнёр.' : ''}</p>
      <textarea id="step" maxlength="500" style="min-height:70px" placeholder="Например: если задерживаюсь, пишу до 18:00">${esc(summary.step)}</textarea>
      <button id="finish" style="margin-top:10px">Сохранить итог</button>
      <button class="ghost" data-summaryclose>Ещё поговорим</button>
    </div>`}`;
  const h = document.getElementById('heard');
  if (h) {
    h.oninput = () => (summary.heard = h.value);
    const st = document.getElementById('step');
    st.oninput = () => (summary.step = st.value);
    document.getElementById('finish').onclick = async () => {
      try {
        const r = await api('/api/talk/finish', summary);
        summary = null; haptic('medium');
        if (r.done) { showSummary = false; toast('Итог сохранён 🌿'); }
        refresh(true);
      } catch (e) { toast(e.message); }
    };
  }
}
let showSummary = false;
// Главная: две кнопки. 'home' — главная, 'talk' — разговор, 'signal' — знаки партнёру.
let view = 'home';

const ICON = {
  sign: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19.5s-7-4.3-7-9.3A3.8 3.8 0 0 1 12 8a3.8 3.8 0 0 1 7 2.2c0 5-7 9.3-7 9.3z"/></svg>',
  talk: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5C4 5.1 5.1 4 6.5 4h7C14.9 4 16 5.1 16 6.5v4c0 1.4-1.1 2.5-2.5 2.5H9l-3.5 3v-3H6.5C5.1 13 4 11.9 4 10.5z"/><path d="M18 9h.5c.8 0 1.5.7 1.5 1.5v4c0 .8-.7 1.5-1.5 1.5H18v2.5L15 16h-3"/></svg>',
};

function goTalk() { view = 'talk'; sigForm = null; }

// Что ждёт ответа: показываем на главной, чтобы ничего не потерялось.
function waitingCards() {
  const o = S.open;
  const out = [];
  if (S.talk && S.talk.partnerHeard && !S.talk.heardMine) out.push(`<div class="card talk"><b>🌿 ${esc(S.partner.name)} подводит итог разговора</b><p class="muted" style="margin:6px 0 10px">Напишите и вы, что услышали, чтобы увидеть итог.</p><button data-gotalk>Открыть</button></div>`);
  if (o && o.kind === 'together' && !o.answeredBy.includes(S.me.id)) out.push(`<div class="card warm"><b>📖 Вопрос для вас обоих</b><p class="question" style="font-size:17px;margin:8px 0">${esc(o.text)}</p><button data-gotalk>Ответить</button></div>`);
  else if (o && o.to === S.me.id && o.kind !== 'together') out.push(`<div class="card warm"><b>${o.kind === 'say' ? `💬 ${esc(S.partner.name)} хочет вам что-то сказать` : `💌 ${esc(S.partner.name)} задал(а) вам вопрос`}</b><p class="question" style="font-size:17px;margin:8px 0">${esc(o.text)}</p><button data-gotalk>${o.kind === 'say' ? 'Прочитать' : 'Ответить'}</button></div>`);
  return out.join('');
}

function renderHome() {
  const t = S.talk;
  const talkNote = t ? `Идёт разговор: ${esc(config.topics[t.topic])}, ступень ${t.stage} из 5`
    : S.open && S.open.from === S.me.id ? `Ждём ответа ${esc(S.partner.name)}`
    : S.pair.myTurn ? 'Задать вопрос или сказать своё, по очереди' : `Сейчас очередь ${esc(S.partner.name)}`;
  $app.innerHTML = `
    ${pauseAskCard()}${incomingSignals()}${waitingCards()}${replyCard()}${stepCard()}${ideasCard()}${lastTalkCard()}
    <div class="home">
      <p class="eyebrow">Когда чуть остыли</p>
      <h1>Как вы сейчас?</h1>
      <p class="lead">Можно просто дать знак, без слов. А когда будете готовы, поговорить по шагам.</p>
      <button class="big-choice" data-gosign>
        <span class="ic">${ICON.sign}</span>
        <span><b>Дать знак</b><small>Одна кнопка: «мне нужно остыть», «давай помиримся», «скучаю»</small></span>
      </button>
      <button class="big-choice" data-gotalk>
        <span class="ic">${ICON.talk}</span>
        <span><b>Поговорить</b><small>${talkNote}</small></span>
      </button>
    </div>
    ${mySignals()}`;
  bindReply();
  bindSignalInputs();
}

function renderSignalView() {
  $app.innerHTML = `<button class="back" data-gohome>← Назад</button>
    <h1 style="margin-top:6px">Дать знак</h1>
    <p class="lead" style="margin-bottom:14px">${esc(S.partner.name)} получит сообщение в Telegram и сможет ответить одной кнопкой.</p>
    ${signalPanel().replace('<h2>Быстрый знак партнёру</h2>', '').replace(/<p class="muted">Одна кнопка, и[^<]*<\/p>/, '')}
    ${mySignals()}`;
  bindSignalInputs();
}
let answer = { text: '', rating: null };
let sideDraft = null;
let library = { tone: null, items: [] };

function localStorageGet(k) { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem(k, v); } catch {} }

async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (inTelegram) headers['X-Init-Data'] = tg.initData;
  else headers['X-Demo-User'] = demoUser;
  const r = await fetch(path, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (data.safety) { S.me.safety = true; render(); throw new Error(''); }
  if (!r.ok) throw new Error(data.error || 'Ошибка сети');
  return data;
}

function toast(msg) {
  if (!msg) return;
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}
function haptic(type = 'light') { try { tg?.HapticFeedback?.impactOccurred(type); } catch {} }

const toneLabel = (t) => (config.tones[t] ? `${config.tones[t].emoji} ${config.tones[t].label}` : 'не выбран');
const srcLabel = { own: '✍️ свой', library: '📚 из библиотеки', ai: '✨ от ИИ' };
const srcBadge = (q) => (q.kind === 'say' ? '💬 сказал(а)' : q.kind === 'together' ? '👫 вдвоём' : q.edited ? '✍️ своими словами' : srcLabel[q.source]);
const SAY_STARTERS = ['Мне важно…', 'Мне жаль, что…', 'Я ценю, что ты…', 'Я боюсь, что…', 'Я прошу…', 'Мне не хватает…'];

// Посыл партнёра: его собственные слова, которые видны перед вопросами.
function partnerMessageCard() {
  const m = S.partner?.message;
  if (!m) return '';
  return `<div class="card msg"><p class="muted">💌 ${esc(S.partner.name)} хочет, чтобы вы знали</p><div class="msgtext">${esc(m)}</div></div>`;
}

function replyCard() {
  const q = S.pendingReply;
  if (!q) return '';
  return `<div class="card warm">
    <p class="muted">${esc(S.partner.name)} ${q.kind === 'say' ? 'откликнулся(ась) на ваши слова' : 'ответил(а) на ваш вопрос'}:</p>
    <p class="muted" style="margin-bottom:4px">«${esc(q.text)}»</p>
    <div class="a">${esc(q.answer)}${q.voice ? voiceBtn(q) : ''}</div>
    <h2 style="margin-top:14px">Скажите ${esc(S.partner.name)} пару слов</h2>
    <textarea id="reply" style="min-height:70px" maxlength="600" placeholder="Например: Спасибо, что сказал(а). Я не знал(а), что тебе так тяжело.">${esc(replyDraft)}</textarea>
    <div class="row" style="margin-top:8px"><button id="replySend">Отправить</button><button class="ghost" id="replySkip">Пропустить</button></div>
  </div>`;
}

function bindReply() {
  const ta = document.getElementById('reply');
  if (!ta) return;
  ta.oninput = () => (replyDraft = ta.value);
  const go = async (text) => {
    try { await api('/api/reply', { id: S.pendingReply.id, text }); replyDraft = ''; if (text) { haptic('medium'); toast('Отправлено 💬'); } refresh(true); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('replySend').onclick = () => { if (!replyDraft.trim()) return toast('Напишите пару слов или нажмите «Пропустить»'); go(replyDraft.trim()); };
  document.getElementById('replySkip').onclick = () => go('');
}
const rateLabel = { love: '❤️ В точку', like: '👍 Хороший', meh: '👎 Не моё' };

async function refresh(force = false) {
  try {
    const s = await api('/api/state');
    const json = JSON.stringify(s);
    if (!force && json === lastJson) return;
    lastJson = json; S = s;
    if (sideDraft === null) sideDraft = S.me.situation || '';
    render();
  } catch (e) {
    $app.innerHTML = `<div class="center">${esc(e.message)}</div>`;
  }
}

// ---------- Экраны ----------
function render() {
  document.getElementById('tabs').hidden = !(S.pair && S.partner);
  document.querySelectorAll('#tabs button').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  if (!S.pair) return renderStart();
  if (!S.partner) return renderInvite();
  if (!S.me.tone) return renderTonePick(true);
  const dot = document.querySelector('#tabs [data-tab="daily"]');
  if (dot) dot.classList.toggle('dot', Boolean(S.daily && S.daily.mine == null));
  if (S.me.safety) return renderSafety();
  if (solo && tab === 'game') return renderSolo();
  if (tab === 'game' && sigForm) view = 'signal';
  if (tab === 'game' && (view === 'home' || (view === 'signal' && false))) return renderHome();
  if (tab === 'game' && view === 'signal') return renderSignalView();
  ({ game: renderGame, daily: renderDaily, side: renderSide, tone: () => renderTonePick(false), history: renderHistory }[tab])();
  if (tab === 'game') decorateGame();
  if (tab === 'tone') $app.insertAdjacentHTML('afterbegin', '<button class="back" data-go="side">← Мои слова</button>');
}

function renderStart() {
  const join = new URLSearchParams(location.search).get('join') || '';
  $app.innerHTML = `
    <div class="welcome">
      <p class="eyebrow">Для момента, когда чуть остыли</p>
      <img class="art" src="brand/artwork.jpg" alt="Раскрытая книга со светом между страниц" />
      <h1>Начать разговор<br>можно мягко.</h1>
      <p class="lead"><b>Прочитай меня, а я тебя.</b> Самая острая ссора позади, но слова ещё не находятся. «Прочитай меня» помогает начать с малого: дать знак одной кнопкой, а потом поговорить по шагам, задавая друг другу вопросы по очереди.</p>
      ${join ? `<div class="card warm invite"><b>Вас пригласили в «Прочитай меня»</b>
        <p style="margin:8px 0 0">Здесь никто не судит и не решает, кто прав. Вы отвечаете на вопросы своими словами, и ваш ответ закрыт, пока не ответите оба. Остановиться можно в любой момент.</p></div>` : ''}
      <p class="muted">ИИ-помощник подсказывает вопросы. Он читает только то, что вы сами ему напишете в «Моей стороне», и не пересказывает это партнёру.</p>
    </div>
    <div class="card">
      <h2>Как вас зовут?</h2>
      <input id="name" value="${esc(S.me.name)}" maxlength="40" />
    </div>
    <div class="card">
      <h2>Начать</h2>
      <button id="create">Создать пару и пригласить</button>
      <p class="muted" style="margin:14px 0 6px">или введите код от партнёра</p>
      <div class="row"><input id="code" placeholder="КОД" value="${esc(join)}" style="text-transform:uppercase" /><button id="join" class="ghost">Войти</button></div>
    </div>
    <p class="foot">Можно остановиться в любой момент</p>`;
  const saveName = () => api('/api/profile', { name: document.getElementById('name').value });
  document.getElementById('create').onclick = async () => { await saveName(); await api('/api/pair/create', {}); refresh(true); };
  document.getElementById('join').onclick = async () => {
    try { await saveName(); await api('/api/pair/join', { code: document.getElementById('code').value.trim() }); haptic('medium'); refresh(true); }
    catch (e) { toast(e.message); }
  };
}

function renderInvite() {
  const link = S.pair.invite;
  $app.innerHTML = `
    <div class="card hero"><p class="eyebrow">Мягкое приглашение</p><h1>Позовите партнёра</h1>
      <p class="lead">Лучше отправить, когда вы оба чуть остыли. Мы приложим к ссылке короткое объяснение: что это, что никто не судит и что ответы закрыты, пока не ответите оба.</p></div>
    <div class="card">
      <h2>Код пары</h2>
      <div class="code">${esc(S.pair.code)}</div>
      ${link ? '<button id="share">Отправить приглашение</button>' : '<p class="muted">Передайте этот код партнёру. В Telegram здесь будет кнопка «Отправить приглашение».</p>'}
      <button class="ghost" id="copy">Скопировать ${link ? 'ссылку' : 'код'}</button>
    </div>
    <div class="card"><button class="ghost" id="leave">Отменить пару</button></div>`;
  const text = 'Мне важно, чтобы мы слышали друг друга, даже после ссоры. Это «Прочитай меня»: здесь никто не судит, мы по очереди задаём друг другу вопросы, и ответы открываются, только когда ответили оба. Попробуешь со мной?';
  if (link) document.getElementById('share').onclick = () =>
    tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`);
  document.getElementById('copy').onclick = () => { navigator.clipboard?.writeText(link || S.pair.code); toast('Скопировано'); };
  document.getElementById('leave').onclick = async () => { await api('/api/pair/leave', {}); refresh(true); };
}

function renderTonePick(first) {
  const tones = Object.entries(config.tones);
  const ins = S.insights;
  $app.innerHTML = `
    ${first ? '<div class="card hero"><div class="big">🎚️</div><h1>Какие вопросы вам ближе?</h1><p class="muted">Партнёр увидит ваш выбор и сможет подстроиться. Поменять можно в любой момент.</p></div>' : ''}
    <div class="card">
      <h2>Мой тон</h2>
      <div class="chips">${tones.map(([k, t]) => `<button class="chip ${S.me.tone === k ? 'on' : ''}" data-tone="${k}">${t.emoji} ${t.label}</button>`).join('')}</div>
      <p class="muted">${tones.map(([, t]) => `${t.emoji} ${t.hint}`).join('<br>')}</p>
    </div>
    ${first ? '' : `
    <div class="card">
      <h2>${esc(S.partner.name)}: что откликается</h2>
      <p>Выбранный тон: <b>${toneLabel(S.partner.tone)}</b></p>
      ${insightBlock(ins.partner, S.partner.name)}
    </div>
    <div class="card">
      <h2>Мне: что откликается</h2>
      <p class="muted">По вашим оценкам. Партнёр видит то же самое.</p>
      ${insightBlock(ins.me, 'вы')}
    </div>
    <div class="card"><button class="ghost" id="leave">Выйти из пары</button></div>`}`;
  $app.querySelectorAll('[data-tone]').forEach((b) => (b.onclick = async () => {
    await api('/api/profile', { tone: b.dataset.tone }); haptic(); refresh(true);
  }));
  const leave = document.getElementById('leave');
  if (leave) leave.onclick = async () => {
    const ok = inTelegram ? await new Promise((r) => tg.showConfirm('Выйти из пары? История пропадёт.', r)) : true;
    if (ok) { await api('/api/pair/leave', {}); sideDraft = null; refresh(true); }
  };
}

function insightBlock(i, who) {
  if (!i || !i.rated) return '<p class="muted">Пока нет оценок. Они появятся после первых ответов.</p>';
  const bar = (x, label) => `<div class="row" style="justify-content:space-between"><span>${label}</span><span class="muted">${x.n} оц.</span></div><div class="bar"><i style="width:${(x.avg / 2) * 100}%"></i></div>`;
  const top = i.byTone[0];
  return `
    ${top && top.avg >= 1 ? `<p>Больше всего ${who === 'вы' ? 'вам ' : ''}откликаются вопросы в тоне <b>${toneLabel(top.key)}</b>.</p>` : ''}
    ${i.byTone.map((x) => bar(x, toneLabel(x.key))).join('')}
    ${i.bySource.map((x) => bar(x, srcLabel[x.key])).join('')}
    ${i.loved.length ? `<p class="muted" style="margin-top:8px">Вопросы, которые попали в точку:</p>${i.loved.map((t) => `<p>❤️ ${esc(t)}</p>`).join('')}` : ''}`;
}

function renderGame() {
  const o = S.open;
  if (S.talk && (showSummary || S.talk.heardMine)) return renderSummary();
  if (o && o.kind === 'together') return renderTogether(o);
  if (o && o.to === S.me.id) return renderAnswer(o);
  if (o && o.from === S.me.id) {
    $app.innerHTML = `
      <div class="card hero"><div class="big">⏳</div><h1>Ждём ответ ${esc(S.partner.name)}</h1>
        <p class="muted">Мы пришлём уведомление в Telegram, когда ответ придёт.</p></div>
      <div class="card">${o.kind === 'say' ? '<p class="muted">Вы сказали:</p>' : `<span class="badge">${toneLabel(o.tone)}</span><span class="badge">${srcBadge(o)}</span>`}
        <div class="question">${esc(o.text)}</div>${o.why ? `<p class="muted">Зачем: ${esc(o.why)}</p>` : ''}</div>
      ${talkBar()}${dailyHint()}${messageHint()}${sideHint()}`;
    return;
  }
  if (!S.pair.myTurn) {
    $app.innerHTML = `${lastTalkCard()}${replyCard()}${talkBar()}${startTalkCard()}<div class="card hero"><div class="big">🤍</div><h1>Сейчас ход ${esc(S.partner.name)}</h1>
      <p class="muted">Скоро вам придёт вопрос.</p></div>${dailyHint()}${partnerMessageCard()}${messageHint()}${sideHint()}`;
    bindReply();
    return;
  }
  renderCompose();
}

function dailyHint() {
  const d = S.daily;
  if (!d || d.mine != null) return '';
  return `<div class="card sun"><p class="muted">☀️ Вопрос дня${d.partnerAnswered ? ` · ${esc(S.partner.name)} уже ответил(а)` : ''}</p>
    <b>${esc(d.text)}</b><button class="ghost" data-go="daily" style="margin-top:10px">Ответить</button></div>`;
}

function renderDaily() {
  const d = S.daily;
  const names = { [S.me.id]: 'Вы' };
  const duo = (answers) => `<div class="duo">${Object.entries(answers).sort(([a]) => (a === S.me.id ? -1 : 1))
    .map(([m, t]) => `<div><span class="muted">${names[m] || esc(S.partner.name)}</span>${esc(t)}</div>`).join('')}</div>`;
  let body;
  if (d.answers) body = `<p class="muted" style="margin-top:10px">Страницы открылись:</p>${duo(d.answers)}`;
  else if (d.mine != null) body = `<div class="pair-status" style="margin-top:10px"><span class="ok">✓ Вы</span><span>… ${esc(S.partner.name)}</span></div>
    <p class="muted" style="margin-top:10px">📕 Ваша страница пока закрыта. Она откроется, когда ответит ${esc(S.partner.name)}.</p>`;
  else body = `<p class="muted" style="margin-top:6px">${d.partnerAnswered ? `${esc(S.partner.name)} уже ответил(а). Ответьте, и вы увидите ответы друг друга.` : 'Ответы откроются, когда ответите оба.'}</p>
    <textarea id="dtext" maxlength="1000" placeholder="Ваш ответ">${esc(dailyDraft)}</textarea>
    <button id="dsend" class="${d.partnerAnswered ? 'coral' : ''}" style="margin-top:10px">${d.partnerAnswered ? 'Ответить и открыть' : 'Ответить'}</button>`;
  const streak = d.streak
    ? `<div class="streak">${d.streak} ${plural(d.streak, 'день', 'дня', 'дней')} подряд вы открываете страницу вместе</div>`
    : '<div class="streak muted">Страница дня — это лёгкий вопрос для спокойного времени, не только после ссоры. Так проще оставаться рядом.</div>';
  $app.innerHTML = `
    <div class="card sun">
      <p class="muted">☀️ Вопрос дня · ${new Date(d.date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</p>
      <div class="question">${esc(d.text)}</div>
      ${body}
    </div>
    ${streak}
    ${d.past.length ? `<h2 style="padding:8px 4px 0">Прошлые дни</h2>${d.past.map((x) => `
      <div class="card hist"><p class="muted">${new Date(x.date + 'T12:00:00').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' })}</p>
        <b>${esc(x.text)}</b>${x.answers ? duo(x.answers) : '<p class="muted" style="margin-top:6px">Ответил только один из вас.</p>'}</div>`).join('')}` : ''}
    <p class="muted center" style="padding:12px 0">Новый вопрос приходит каждое утро в Telegram.</p>`;
  const ta = document.getElementById('dtext');
  if (ta) {
    ta.oninput = () => (dailyDraft = ta.value);
    document.getElementById('dsend').onclick = async () => {
      try { const r = await api('/api/daily', { answer: dailyDraft }); dailyDraft = ''; haptic('medium'); toast(r.both ? 'Страницы открылись 📖' : 'Ваша страница закрыта до ответа партнёра 📕'); refresh(true); }
      catch (e) { toast(e.message); }
    };
  }
}

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

function messageHint() {
  if (S.me.message) return '';
  return `<div class="card warm"><h2>💌 Ваш посыл партнёру</h2>
    <p class="muted">Что вы хотите, чтобы ${esc(S.partner.name)} знал(а) перед разговором? Например: «Я не хочу ругаться. Я скучаю по нам». Это увидит ${esc(S.partner.name)}.</p>
    <button data-go="side">Написать посыл</button></div>`;
}

function sideHint() {
  if (S.me.situation) return '';
  return `<div class="card"><h2>🔒 Расскажите свою сторону</h2>
    <p class="muted">Так ИИ сможет подсказывать точные вопросы. ${esc(S.partner.name)} ваш текст не увидит.</p>
    <button class="ghost" data-go="side">Написать</button></div>`;
}

function renderCompose() {
  compose.tone ??= S.partner.tone || 'gentle';
  const tones = Object.entries(config.tones);
  const m = compose.mode;
  $app.innerHTML = `
    ${lastTalkCard()}${talkBar()}${startTalkCard()}
    ${partnerMessageCard()}
    <div class="card">
      <h1>Ваш ход ✨</h1>
      <p class="muted">${m === 'say' ? `Скажите ${esc(S.partner.name)} что-то своё, без вопроса.` : `Задайте ${esc(S.partner.name)} один вопрос.`} ${m !== 'say' && S.partner.tone ? `${esc(S.partner.name)} предпочитает тон ${toneLabel(S.partner.tone)}.` : ''}</p>
      <div class="modes">
        <button data-mode="own" class="${m === 'own' ? 'on' : ''}"><span>✍️</span>Свой</button>
        <button data-mode="say" class="${m === 'say' ? 'on' : ''}"><span>💬</span>Сказать</button>
        <button data-mode="library" class="${m === 'library' ? 'on' : ''}"><span>📚</span>Библиотека</button>
        <button data-mode="ai" class="${m === 'ai' ? 'on' : ''}"><span>✨</span>ИИ</button>
      </div>
      ${m === 'library' || m === 'ai' ? `<div class="chips">${tones.map(([k, t]) => `<button class="chip ${compose.tone === k ? 'on' : ''}" data-ctone="${k}">${t.emoji} ${t.label}</button>`).join('')}</div>` : ''}
      <div id="pane"></div>
    </div>
    ${messageHint()}${sideHint()}`;
  const pane = document.getElementById('pane');

  if (m === 'own') {
    pane.innerHTML = `
      <textarea id="qtext" placeholder="Например: Что тебе было бы важно услышать от меня сейчас?">${esc(compose.text)}</textarea>
      <div class="chips">${tones.map(([k, t]) => `<button class="chip ${compose.tone === k ? 'on' : ''}" data-ctone="${k}">${t.emoji} ${t.label}</button>`).join('')}</div>
      ${whyField()}
      <button id="send">Отправить вопрос</button>`;
  } else if (m === 'say') {
    pane.innerHTML = `
      <p class="muted">Начните с заготовки, а дальше своими словами:</p>
      <div class="chips">${SAY_STARTERS.map((t, i) => `<button class="chip" data-starter="${i}">${esc(t)}</button>`).join('')}</div>
      <textarea id="qtext" maxlength="1000" placeholder="Например: Мне важно знать заранее, если ты задерживаешься, потому что я жду тебя весь вечер.">${esc(compose.text)}</textarea>
      <button id="send" style="margin-top:10px">Сказать ${esc(S.partner.name)}</button>`;
  } else if (m === 'library') {
    if (library.tone !== compose.tone) { loadLibrary(); pane.innerHTML = '<p class="muted">Загрузка…</p>'; }
    else pane.innerHTML = `<div class="qlist">${library.items.map((q, i) =>
      `<button data-pick="${i}" class="${compose.picked === q.text ? 'on' : ''} ${q.asked ? 'asked' : ''}">${q.stage ? `<span class="stagetag">Ступень ${q.stage}</span>` : ''}${esc(q.text)}${q.asked ? ' <span class="muted">(уже был)</span>' : ''}</button>`).join('')}</div>
      ${pickedEditor()}`;
  } else {
    pane.innerHTML = `
      <div class="private"><span>🔒</span><span>ИИ знает стороны вас обоих, но не пересказывает их. Вопросы будут общими и бережными.${S.aiEnabled ? '' : ' <b>Ключ ИИ пока не подключён, поэтому подсказки берутся из библиотеки.</b>'}</span></div>
      ${!S.partner.sideFilled ? `<p class="muted">${esc(S.partner.name)} ещё не рассказал(а) свою сторону, подсказки будут менее точными.</p>` : ''}
      <button id="gen" ${compose.loading ? 'disabled' : ''}>${compose.loading ? 'Думаю…' : compose.suggestions ? 'Предложить другие' : 'Предложить 3 вопроса'}</button>
      ${compose.suggestions ? `<div class="qlist" style="margin-top:12px">${compose.suggestions.map((t, i) =>
        `<button data-sug="${i}" class="${compose.picked === t ? 'on' : ''}">${esc(t)}</button>`).join('')}</div>${pickedEditor()}` : ''}`;
  }
  bindCompose();
}

function pickedEditor() {
  if (!compose.picked) return '';
  return `<p class="muted" style="margin-top:8px">Это черновик. Скажите по-своему, так вопрос станет вашим:</p>
    <textarea id="qtext">${esc(compose.text)}</textarea>${whyField()}<button id="send">Отправить вопрос</button>`;
}

// «Отвечаем вдвоём»: переключатель под вопросом.
function togetherToggle() {
  return `<label class="toggle"><input type="checkbox" id="together" ${compose.together ? 'checked' : ''} />
    <span><b>👫 Ответим оба</b><br><span class="muted">Вы тоже отвечаете на этот вопрос. Ответы откроются одновременно, когда ответите оба, так никто не подстраивается.</span></span></label>`;
}

// «Зачем я спрашиваю»: одна строка от себя, партнёр читает её над вопросом.
function whyField() {
  return `${togetherToggle()}<div class="why"><label for="qwhy">Зачем я спрашиваю <span class="muted">(увидит ${esc(S.partner.name)}, можно пропустить)</span></label>
    <input id="qwhy" maxlength="300" placeholder="Например: хочу понять тебя, а не спорить" value="${esc(compose.why)}" /></div>`;
}

async function loadLibrary() {
  const tone = compose.tone;
  const r = await api(`/api/library?tone=${tone}`);
  library = { tone, items: r.questions };
  if (tab === 'game') render();
}

function bindCompose() {
  $app.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
    compose.mode = b.dataset.mode; compose.picked = null;
    if (compose.mode === 'own' || compose.mode === 'say') compose.text = '';
    render();
  }));
  $app.querySelectorAll('[data-ctone]').forEach((b) => (b.onclick = () => {
    compose.tone = b.dataset.ctone; if (compose.mode !== 'own') { compose.picked = null; compose.suggestions = null; }
    render();
  }));
  $app.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => {
    compose.picked = compose.text = library.items[b.dataset.pick].text; compose.source = 'library'; render();
  }));
  $app.querySelectorAll('[data-sug]').forEach((b) => (b.onclick = () => {
    compose.picked = compose.text = compose.suggestions[b.dataset.sug]; render();
  }));
  const ta = document.getElementById('qtext');
  if (ta) ta.oninput = () => (compose.text = ta.value);
  const tg2 = document.getElementById('together');
  if (tg2) tg2.onchange = () => (compose.together = tg2.checked);
  const why = document.getElementById('qwhy');
  if (why) why.oninput = () => (compose.why = why.value);
  $app.querySelectorAll('[data-starter]').forEach((b) => (b.onclick = () => {
    const st = SAY_STARTERS[b.dataset.starter].replace('…', ' ');
    compose.text = compose.text.trim() ? `${compose.text.trim()} ${st}` : st;
    render();
    const t = document.getElementById('qtext'); t.focus(); t.setSelectionRange(t.value.length, t.value.length);
  }));
  const gen = document.getElementById('gen');
  if (gen) gen.onclick = async () => {
    compose.loading = true; compose.picked = null; render();
    try {
      const r = await api('/api/ai/suggest', { tone: compose.tone });
      compose.suggestions = r.questions; compose.source = r.source;
    } catch (e) { toast(e.message); }
    compose.loading = false; render();
  };
  const send = document.getElementById('send');
  if (send) send.onclick = async () => {
    const m = compose.mode;
    const source = m === 'own' || m === 'say' ? 'own' : m === 'library' ? 'library' : compose.source;
    const edited = Boolean(compose.picked) && compose.text.trim() !== compose.picked.trim();
    try {
      send.disabled = true;
      await api('/api/question', { kind: m === 'say' ? 'say' : compose.together ? 'together' : 'ask', text: compose.text, tone: compose.tone, source, why: compose.why, edited });
      haptic('medium'); toast(m === 'say' ? 'Отправлено 💬' : compose.together ? 'Вопрос отправлен. Теперь ответьте и вы 👫' : 'Вопрос отправлен 💌');
      compose = freshCompose(m === 'say' ? 'own' : m);
      refresh(true);
    } catch (e) { toast(e.message); send.disabled = false; }
  };
}

function renderAnswer(o) {
  if (o.kind === 'say') return renderHear(o);
  $app.innerHTML = `
    ${partnerMessageCard()}
    ${o.why ? `<div class="card warm"><p class="muted">${esc(o.fromName)} спрашивает, потому что:</p><div class="msgtext">${esc(o.why)}</div></div>` : ''}
    <div class="card">
      <p class="muted">${esc(o.fromName)} спрашивает:</p>
      <div class="question">${esc(o.text)}</div>
      <span class="badge">${toneLabel(o.tone)}</span><span class="badge">${srcBadge(o)}</span>
    </div>
    <div class="card">
      <h2>Ваш ответ</h2>
      <textarea id="atext" placeholder="Ответьте честно, как чувствуете">${esc(answer.text)}</textarea>
      <p class="muted" style="margin-top:12px">Как вам этот вопрос? Так ${esc(o.fromName)} поймёт, какие вопросы вам ближе.</p>
      <div class="rating">${Object.entries(rateLabel).map(([k, l]) => `<button data-rate="${k}" class="${answer.rating === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      ${feelChips()}
      <button id="send">Ответить</button>
      ${voiceHint()}
    </div>`;
  const ta = document.getElementById('atext');
  ta.oninput = () => (answer.text = ta.value);
  $app.querySelectorAll('[data-rate]').forEach((b) => (b.onclick = () => { answer.rating = b.dataset.rate; haptic(); render(); }));
  $app.querySelectorAll('[data-feel]').forEach((b) => (b.onclick = () => { feelPick = b.dataset.feel; haptic(); render(); }));
  document.getElementById('send').onclick = async () => {
    try {
      await api('/api/answer', { answer: answer.text, rating: answer.rating, feel: feelPick });
      answer = { text: '', rating: null }; feelPick = null; haptic('medium'); toast('Ответ отправлен. Теперь ваш ход ✨');
      refresh(true);
    } catch (e) { toast(e.message); }
  };
}

// Вопрос вдвоём: каждый отвечает, не видя ответа другого. Потом ответы открываются вместе.
function renderTogether(o) {
  const mine = o.answeredBy.includes(S.me.id);
  const theirs = o.answeredBy.includes(o.from === S.me.id ? o.to : o.from);
  const head = `
    ${o.why ? `<div class="card warm"><p class="muted">${o.from === S.me.id ? 'Вы спрашиваете' : `${esc(o.fromName)} спрашивает`}, потому что:</p><div class="msgtext">${esc(o.why)}</div></div>` : ''}
    <div class="card">
      <p class="muted">👫 Отвечаем вдвоём${o.from === S.me.id ? '' : `, спрашивает ${esc(o.fromName)}`}:</p>
      <div class="question">${esc(o.text)}</div>
      <div class="pair-status"><span class="${mine ? 'ok' : ''}">${mine ? '✓' : '…'} Вы</span><span class="${theirs ? 'ok' : ''}">${theirs ? '✓' : '…'} ${esc(S.partner.name)}</span></div>
    </div>`;
  if (mine) {
    $app.innerHTML = `${head}<div class="card hero"><div class="big">📕</div><h1>Ваша страница пока закрыта</h1>
      <p class="muted">Ответы откроются одновременно, когда ответит ${esc(S.partner.name)}. Мы пришлём уведомление.</p></div>`;
    return;
  }
  const canRate = o.to === S.me.id;
  $app.innerHTML = `${head}
    <div class="card">
      <h2>Ваш ответ</h2>
      <p class="muted">${theirs ? `${esc(S.partner.name)} уже ответил(а). Ответьте, и вы увидите ответы друг друга.` : `${esc(S.partner.name)} не увидит ваш ответ, пока не ответит сам(а).`}</p>
      <textarea id="atext" placeholder="Ответьте честно, как чувствуете">${esc(answer.text)}</textarea>
      ${canRate ? `<p class="muted" style="margin-top:12px">Как вам этот вопрос?</p>
      <div class="rating">${Object.entries(rateLabel).map(([k, l]) => `<button data-rate="${k}" class="${answer.rating === k ? 'on' : ''}">${l}</button>`).join('')}</div>` : ''}
      ${feelChips()}
      <button id="send" class="${theirs ? 'coral' : ''}" style="margin-top:10px">${theirs ? 'Ответить и открыть ответы' : 'Ответить'}</button>
      ${voiceHint()}
    </div>`;
  const ta = document.getElementById('atext');
  ta.oninput = () => (answer.text = ta.value);
  $app.querySelectorAll('[data-rate]').forEach((b) => (b.onclick = () => { answer.rating = b.dataset.rate; haptic(); render(); }));
  $app.querySelectorAll('[data-feel]').forEach((b) => (b.onclick = () => { feelPick = b.dataset.feel; haptic(); render(); }));
  document.getElementById('send').onclick = async () => {
    try {
      const r = await api('/api/answer', { answer: answer.text, rating: answer.rating, feel: feelPick });
      answer = { text: '', rating: null }; feelPick = null; haptic('medium');
      if (r.done) { tab = 'history'; toast('Страницы открылись 📖'); } else toast('Ваша страница закрыта до ответа партнёра 📕');
      refresh(true);
    } catch (e) { toast(e.message); }
  };
}

// Партнёр не спросил, а сказал что-то своё: можно ответить или просто дать понять, что услышал(а).
// Голосовой ответ: записывается в чате с ботом и сразу становится ответом.
function voiceHint() {
  if (!config.voice) return '';
  return `<div class="voicehint"><span>🎙</span><span><b>Хотите ответить голосом?</b> Запишите голосовое в чате с ботом, и оно станет ответом. ${inTelegram ? '<a href="#" data-tochat>Перейти в чат</a>' : ''}</span></div>`;
}

async function playVoice(btn) {
  if (btn.dataset.loading) return;
  btn.dataset.loading = '1'; btn.textContent = '⏳ Загрузка…';
  try {
    const headers = inTelegram ? { 'X-Init-Data': tg.initData } : { 'X-Demo-User': demoUser };
    const r = await fetch(`/api/voice/${btn.dataset.voice}${btn.dataset.who ? `?who=${btn.dataset.who}` : ''}`, { headers });
    if (!r.ok) throw new Error();
    const audio = document.createElement('audio');
    audio.controls = true; audio.src = URL.createObjectURL(await r.blob());
    btn.replaceWith(audio); audio.play().catch(() => {});
  } catch { btn.textContent = 'Не удалось загрузить. Голос есть в чате с ботом.'; }
}
const voiceBtn = (q, who) => `<button class="ghost voice" data-voice="${q.id}" ${who ? `data-who="${who}"` : ''}>▶️ Послушать</button>`;

function renderHear(o) {
  $app.innerHTML = `
    <div class="card warm">
      <p class="muted">${esc(o.fromName)} хочет вам сказать:</p>
      <div class="question">${esc(o.text)}</div>
    </div>
    <div class="card">
      <h2>Ваш отклик</h2>
      <textarea id="atext" placeholder="Ответьте своими словами, если хочется">${esc(answer.text)}</textarea>
      <button id="send" style="margin-top:10px">Ответить</button>
      <button class="ghost" id="heard">🤍 Я тебя услышал(а)</button>
    </div>`;
  const ta = document.getElementById('atext');
  ta.oninput = () => (answer.text = ta.value);
  const go = async (text) => {
    try { await api('/api/answer', { answer: text }); answer = { text: '', rating: null }; haptic('medium'); toast('Отправлено. Теперь ваш ход ✨'); refresh(true); }
    catch (e) { toast(e.message); }
  };
  document.getElementById('send').onclick = () => { if (!answer.text.trim()) return toast('Напишите пару слов или нажмите «Я тебя услышал(а)»'); go(answer.text); };
  document.getElementById('heard').onclick = () => go('');
}

function renderSide() {
  if (msgDraft === null) msgDraft = S.me.message || '';
  $app.innerHTML = `
    <div class="card warm">
      <h1>💌 Мой посыл партнёру</h1>
      <p class="muted">Что вы хотите, чтобы ${esc(S.partner.name)} знал(а) перед разговором и во время него. Это <b>увидит ${esc(S.partner.name)}</b>, над каждым вашим вопросом.</p>
      <textarea id="msg" style="min-height:90px" maxlength="600" placeholder="Например: Я не хочу ругаться. Я скучаю по нашим вечерам и хочу понять тебя.">${esc(msgDraft)}</textarea>
      <button id="saveMsg" style="margin-top:10px">${S.me.message ? 'Обновить посыл' : 'Отправить посыл'}</button>
    </div>
    ${partnerMessageCard()}
    <div class="card">
      <h1>🔒 Моя сторона</h1>
      <div class="private"><span>👁️</span><span>Этот текст читает <b>ИИ-помощник</b>, чтобы подбирать вопросы точнее. ${esc(S.partner.name)} его не увидит, и ИИ не будет его цитировать или пересказывать. Можно не заполнять.</span></div>
      <p class="muted">Что произошло, что вы чувствуете, чего хотите и чего боитесь. Пишите как есть.</p>
      <textarea id="side" style="min-height:220px" maxlength="4000" placeholder="Например: мы спорим о том, как проводить выходные. Мне обидно, что…">${esc(sideDraft)}</textarea>
      <button id="save" style="margin-top:10px">Сохранить</button>
      ${S.me.situation ? '<button class="ghost" id="clear">Удалить мой текст</button>' : ''}
    </div>
    <div class="card"><p class="muted">${esc(S.partner.name)} ${S.partner.sideFilled ? 'уже рассказал(а) свою сторону.' : 'пока не рассказал(а) свою сторону.'}</p></div>
    ${makeupCard(false)}
    <button class="ghost" data-go="tone">Тон вопросов и что нам откликается</button>`;
  const ta = document.getElementById('side');
  ta.oninput = () => (sideDraft = ta.value);
  const mt = document.getElementById('msg');
  mt.oninput = () => (msgDraft = mt.value);
  document.getElementById('saveMsg').onclick = async () => {
    await api('/api/profile', { message: msgDraft }); haptic('medium');
    toast(msgDraft.trim() ? `Посыл отправлен ${S.partner.name} 💌` : 'Посыл удалён'); refresh(true);
  };
  document.getElementById('save').onclick = async () => { await api('/api/profile', { situation: sideDraft }); toast('Сохранено 🔒'); refresh(true); };
  const clear = document.getElementById('clear');
  if (clear) clear.onclick = async () => { sideDraft = ''; await api('/api/profile', { situation: '' }); refresh(true); };
  bindSignalInputs();
}

function renderHistory() {
  const who = (id) => (id === S.me.id ? 'Вы' : esc(S.partner.name));
  const date = (t) => new Date(t).toLocaleDateString('ru-RU');
  const items = [
    ...S.history.map((q) => ({ t: q.answeredAt || q.createdAt, html: `
    <div class="card hist">
      <p class="muted">${who(q.from)} ${q.kind === 'say' ? 'сказали' : q.kind === 'together' ? 'спросили обоих' : 'спросили'} · ${date(q.createdAt)}</p>
      ${q.why ? `<p class="muted">Зачем: ${esc(q.why)}</p>` : ''}
      <b>${esc(q.text)}</b>
      ${q.answers
        ? `<div class="duo">${[q.from, q.to].map((m) => `<div><span class="muted">${who(m)}</span>${esc(q.answers[m])}${q.voices?.[m] ? voiceBtn(q, m) : ''}</div>`).join('')}</div>`
        : `<div class="a"><span class="muted">${who(q.to)}:</span> ${esc(q.answer)}${q.voice ? voiceBtn(q) : ''}</div>`}
      ${q.reply ? `<div class="a r"><span class="muted">${who(q.from)}:</span> ${esc(q.reply)}</div>` : ''}
      <p style="margin-top:8px">${q.kind === 'say' ? '' : `<span class="badge">${toneLabel(q.tone)}</span>`}<span class="badge">${srcBadge(q)}</span>${q.rating ? `<span class="badge">${rateLabel[q.rating]}</span>` : ''}</p>
    </div>` })),
    ...(S.letters || []).map((l) => ({ t: l.createdAt, html: `
    <div class="card warm letter">
      <p class="muted">✉️ Письмо: ${who(l.from)} → ${l.to === S.me.id ? 'вам' : esc(S.partner.name)} · ${date(l.createdAt)}</p>
      <div class="msgtext">${esc(l.text)}</div>
    </div>` })),
  ].sort((a, b) => b.t - a.t);
  $app.innerHTML = `<div class="hero" style="padding:14px 2px 6px"><p class="eyebrow">Ваша общая история</p><h1>Наша книга</h1>
    <p class="muted">Страница за страницей здесь собирается то, что вы узнали друг о друге: вопросы, ответы и письма.</p></div>
    <div class="card warm">
      ${letterDraft === null
        ? `<h2>✉️ Письмо партнёру</h2><p class="muted">Короткое письмо своими словами. Например, в конце разговора: что вы услышали и что чувствуете сейчас.</p><button id="letterOpen">Написать письмо</button>`
        : `<h2>✉️ Письмо партнёру</h2>
           <textarea id="letter" maxlength="3000" style="min-height:140px" placeholder="Сегодня я услышал(а), что… Мне важно, чтобы ты знал(а)…">${esc(letterDraft)}</textarea>
           <div class="row" style="margin-top:8px"><button id="letterSend">Отправить</button><button class="ghost" id="letterCancel">Отмена</button></div>`}
    </div>` + (items.length ? items.map((x) => x.html).join('') : '<div class="card center muted">Здесь появятся ваши вопросы, ответы и письма.</div>');
  const open = document.getElementById('letterOpen');
  if (open) open.onclick = () => { letterDraft = ''; renderHistory(); document.getElementById('letter').focus(); };
  const ta = document.getElementById('letter');
  if (ta) {
    ta.oninput = () => (letterDraft = ta.value);
    document.getElementById('letterCancel').onclick = () => { letterDraft = null; renderHistory(); };
    document.getElementById('letterSend').onclick = async () => {
      try { await api('/api/letter', { text: letterDraft }); letterDraft = null; haptic('medium'); toast('Письмо отправлено ✉️'); refresh(true); }
      catch (e) { toast(e.message); }
    };
  }
}

// ---------- Навигация ----------
document.getElementById('tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  tab = b.dataset.tab; render();
};
$app.addEventListener('click', async (e) => {
  const g = e.target.closest('[data-go]'); if (g) { tab = g.dataset.go; render(); return; }
  const vb = e.target.closest('[data-voice]'); if (vb) return playVoice(vb);
  if (e.target.closest('[data-gohome]')) { view = 'home'; sigForm = null; showSummary = false; window.scrollTo(0, 0); return render(); }
  if (e.target.closest('[data-gotalk]')) { goTalk(); window.scrollTo(0, 0); return render(); }
  if (e.target.closest('[data-gosign]')) { view = 'signal'; window.scrollTo(0, 0); return render(); }
  if (e.target.closest('[data-tochat]')) { e.preventDefault(); return tg.close(); }
  const el = e.target.closest('[data-talkopen],[data-talkclose],[data-talkstart],[data-topic],[data-formtemp],[data-settemp],[data-retemp],[data-summary],[data-summaryclose],[data-check]');
  if (!el) return;
  e.preventDefault();
  const d = el.dataset;
  try {
    if ('talkopen' in d) { talkForm = { topic: null, temp: null }; view = 'talk'; }
    else if ('talkclose' in d) talkForm = null;
    else if ('topic' in d) talkForm.topic = d.topic;
    else if ('formtemp' in d) talkForm.temp = Number(d.formtemp);
    else if ('talkstart' in d) {
      if (!talkForm.topic) return toast('Выберите, о чём тупик');
      if (!talkForm.temp) return toast('Отметьте, насколько сейчас горячо');
      await api('/api/talk/start', talkForm); talkForm = null; haptic('medium'); toast('Разговор начат 🕊'); return refresh(true);
    } else if ('settemp' in d) { await api('/api/talk/temp', { temp: Number(d.settemp) }); haptic(); return refresh(true); }
    else if ('retemp' in d) { S.talk.myTemp = null; }
    else if ('summary' in d) showSummary = true;
    else if ('summaryclose' in d) showSummary = false;
    else if ('check' in d) { await api('/api/talk/check', { id: S.lastTalk.id, value: d.check }); toast(d.check === 'no' ? 'Спасибо за честность. Можно начать новый разговор 🕊' : 'Здорово 🌱'); return refresh(true); }
    haptic(); render();
  } catch (err) { toast(err.message); }
});

// ---------- Кнопки-сигналы, «начать одному», что помогает помириться, безопасность ----------
let sigForm = null;   // { kind, note, time } — форма отправки знака
let sigReply = null;  // { id, key, time, note } — ответ на знак, которому нужно время или слова
let solo = null;      // { step, temp, feels, important, msg } — подготовка в одиночку
let lastIdeas = null; // идеи на вечер после «давай проведём время вместе»
let stepDraft = '';
let makeupDraft = null;

const FEELS = ['обидно', 'злюсь', 'устал(а)', 'страшно', 'грустно', 'одиноко', 'растерян(а)', 'стыдно'];
// Слова, которые звучат как упрёк. Подсказка мягкая: решает человек.
const REPROACH = /(ты всегда|ты никогда|ты вечно|ты опять|ты снова|из-за тебя|ты виноват|сколько можно|тебе плевать|тебе всё равно|тебе все равно|как обычно)/i;

function decorateGame() {
  $app.insertAdjacentHTML('afterbegin', `<button class="back" data-gohome>← На главную</button>${incomingSignals()}`);
  bindSignalInputs();
}

// Набранный текст хранится в переменных, чтобы автообновление экрана его не стирало.
function bindSignalInputs() {
  const on = (id, f) => { const el = document.getElementById(id); if (el) el.oninput = () => f(el.value); };
  on('signote', (v) => sigForm && (sigForm.note = v));
  on('sigrnote', (v) => sigReply && (sigReply.note = v));
  on('mstep', (v) => (stepDraft = v));
  on('mkown', (v) => makeupDraft && (makeupDraft.own = v));
}

function incomingSignals() {
  return (S.signals?.pending || []).map((s) => {
    const r = sigReply?.id === s.id ? sigReply : null;
    const picked = r && s.replies.find((x) => x.key === r.key);
    return `<div class="card signal in">
      <p class="muted">${s.emoji} ${esc(S.partner.name)} подаёт знак</p>
      <div class="bubble">${esc(s.text)}</div>
      ${s.note ? `<div class="msgtext" style="margin-top:8px">${esc(s.note)}</div>` : ''}
      ${s.helps && ['makeup', 'sorry'].includes(s.kind) ? `<p class="muted" style="margin:8px 0 0">🤍 ${esc(S.partner.name)} помогает помириться: ${esc(s.helps)}</p>` : ''}
      ${picked ? `
        <p style="margin:12px 0 6px"><b>«${esc(picked.label)}»</b></p>
        ${picked.time ? `<p class="muted" style="margin:0 0 6px">Когда вернётесь к разговору?</p>${timeChips(r.time, 'rtime')}` : ''}
        <input id="sigrnote" maxlength="600" placeholder="Пара своих слов, если хочется" value="${esc(r.note)}" />
        <div class="row" style="margin-top:8px"><button data-rsend>Ответить</button><button class="ghost" data-rcancel>Назад</button></div>`
      : `<div class="replies">${s.replies.map((x) => `<button class="ghost" data-rpick="${s.id}:${x.key}">${esc(x.label)}</button>`).join('')}</div>`}
    </div>`;
  }).join('');
}

function mySignals() {
  return (S.signals?.mine || []).map((s) => {
    const soloOffer = !S.talk && ((s.kind === 'fight' && (s.reply === 'cool' || (!s.reply && Date.now() - s.createdAt > 3 * 3600000)))
      || (['makeup', 'sorry', 'calm'].includes(s.kind) && s.reply === 'later'));
    return `<div class="card signal out">
      <p class="muted">${s.emoji} Вы: «${esc(s.label)}»</p>
      ${s.reply
        ? `<p style="margin:4px 0 0"><b>${esc(S.partner.name)}: «${esc(s.replyLabel)}»</b></p>${s.replyNote ? `<div class="msgtext" style="margin-top:6px">${esc(s.replyNote)}</div>` : ''}`
        : `<p class="muted" style="margin:4px 0 0">Ждём ответа. Мы пришлём уведомление, когда он придёт.</p>`}
      ${s.talk && !S.talk ? '<button data-talkopen style="margin-top:10px">🕊 Начать разговор по ступеням</button>' : ''}
      ${s.kind === 'hurt' && s.reply === 'tell' && S.pair.myTurn ? '<button data-saynow style="margin-top:10px">💬 Сказать своими словами</button>' : ''}
      ${soloOffer ? `<button class="ghost" data-solo style="margin-top:10px">🌬 Подготовиться одному(ой)</button>
        <p class="muted" style="margin:6px 0 0">Остыть и спокойно сформулировать, что хотите сказать. ${esc(S.partner.name)} получит уже спокойное сообщение.</p>` : ''}
    </div>`;
  }).join('');
}

// Пауза закончилась: вернуться или нужно ещё время.
let moreTimePick = null;
function pauseAskCard() {
  const a = S.signals?.ask;
  if (!a) return '';
  return `<div class="card talk"><b>🕊 Время паузы прошло</b>
    <p class="muted" style="margin:6px 0 10px">Готовы вернуться к разговору или нужно ещё время? Это нормально, ${esc(S.partner.name)} подождёт.</p>
    <button data-back="${a.id}">Готов(а) вернуться</button>
    ${moreTimePick ? `<p class="muted" style="margin:10px 0 0">Сколько ещё?</p>${timeChips(moreTimePick, 'mtime')}<button class="ghost" data-more="${a.id}">Взять ещё время</button>`
      : `<button class="ghost" data-moreopen>Нужно ещё время</button>`}
  </div>`;
}

function stepCard() {
  const st = S.signals?.step;
  if (!st) return '';
  const helps = Object.entries(st.helps).filter(([, h]) => h)
    .map(([m, h]) => `<p class="muted" style="margin:4px 0">${m === S.me.id ? 'Вам' : esc(S.partner.name)} помогает: ${esc(h)}</p>`).join('');
  return `<div class="card warm"><b>🤝 Вы оба хотите помириться</b>
    ${helps}
    ${st.step ? `<p style="margin:10px 0 0"><b>Маленький шаг:</b> ${esc(st.step)}</p>` : `
      <p class="muted" style="margin:8px 0 6px">Выберите один маленький шаг, который сделаете сегодня:</p>
      <input id="mstep" maxlength="300" placeholder="Например: обнимемся и погуляем вечером" value="${esc(stepDraft)}" />
      <button data-stepsave style="margin-top:8px">Сохранить шаг</button>`}
  </div>`;
}

function ideasCard() {
  if (!lastIdeas) return '';
  return `<div class="card sun"><b>🫶 Идеи на вечер вдвоём</b>${lastIdeas.map((x) => `<p style="margin:6px 0 0">• ${esc(x)}</p>`).join('')}
    <button class="ghost" data-ideasclose style="margin-top:10px">Спасибо</button></div>`;
}

function timeChips(cur, attr) {
  return `<div class="chips">${Object.entries(config.times).map(([k, l]) => `<button class="chip ${String(cur) === k ? 'on' : ''}" data-${attr}="${k}">${esc(l)}</button>`).join('')}</div>`;
}

function signalPanel() {
  const sig = config.signals || {};
  if (sigForm) {
    const g = sig[sigForm.kind];
    return `<div class="card signal"><h2>${g.emoji} ${esc(g.label)}</h2>
      ${g.time ? `<p class="muted" style="margin:0 0 4px">Когда вы вернётесь к разговору? Мы напомним.</p>${timeChips(sigForm.time, 'stime')}` : ''}
      <p class="muted" style="margin:6px 0">Можно дописать пару своих слов${sigForm.kind === 'sorry' ? ': за что именно, так извинение слышнее' : ''}:</p>
      <textarea id="signote" maxlength="1000" style="min-height:70px" placeholder="Необязательно">${esc(sigForm.note)}</textarea>
      <div class="row" style="margin-top:8px"><button data-ssend>Отправить</button><button class="ghost" data-sclose>Отмена</button></div>
    </div>`;
  }
  return `<div class="card"><h2>Быстрый знак партнёру</h2>
    <p class="muted">Одна кнопка, и ${esc(S.partner.name)} получит сообщение в Telegram с вариантами ответа.</p>
    <div class="sigs">${Object.entries(sig).map(([k, g]) => `<button class="ghost" data-sigopen="${k}"><span>${g.emoji}</span>${esc(g.label)}</button>`).join('')}</div>
  </div>`;
}

function makeupCard(first) {
  const cur = makeupDraft ?? { keys: S.me.makeup || [], own: S.me.makeupOwn || '' };
  makeupDraft = cur;
  return `<div class="card warm"><h2>🤍 Что мне помогает помириться</h2>
    <p class="muted">${esc(S.partner.name)} увидит это, когда вы будете мириться. ${first ? 'Займёт полминуты.' : ''}</p>
    <div class="chips">${Object.entries(config.makeup).map(([k, l]) => `<button class="chip ${cur.keys.includes(k) ? 'on' : ''}" data-mk="${k}">${esc(l)}</button>`).join('')}</div>
    <input id="mkown" maxlength="120" placeholder="Своё, например: когда ты первым(ой) пишешь" value="${esc(cur.own)}" />
    <div class="row" style="margin-top:8px"><button data-mksave>Сохранить</button>${first ? '<button class="ghost" data-mkskip>Позже</button>' : ''}</div>
  </div>`;
}

// Начать одному: остыть, назвать чувства, спокойно написать одно сообщение.
function renderSolo() {
  const st = solo.step;
  const bar = `<div class="steps" style="grid-template-columns:repeat(3,1fr);margin-bottom:12px">${[1, 2, 3].map((n) => `<i class="${n < st ? 'd' : n === st ? 'now' : ''}"></i>`).join('')}</div>`;
  let body;
  if (st === 1) {
    body = `<h1>🌬 Сначала остыть</h1>
      <p class="muted">Сделайте несколько медленных вдохов: вдох на 4 счёта, выдох на 6. Сейчас не нужно ничего решать.</p>
      <p style="margin-top:12px"><b>Насколько вам сейчас горячо?</b> <span class="muted">Видите только вы.</span></p>
      ${tempChips(solo.temp, 'solotemp')}
      <button data-solonext style="margin-top:12px">Дальше</button>`;
  } else if (st === 2) {
    body = `<h1>💭 Что я чувствую</h1>
      <p class="muted">Отметьте одно-два чувства. Это видите только вы.</p>
      <div class="chips">${FEELS.map((f) => `<button class="chip ${solo.feels.includes(f) ? 'on' : ''}" data-feelpick="${esc(f)}">${esc(f)}</button>`).join('')}</div>
      <p><b>Что для меня здесь важно?</b></p>
      <textarea id="soloimp" maxlength="500" style="min-height:70px" placeholder="Например: чтобы меня предупреждали, если планы меняются">${esc(solo.important)}</textarea>
      <div class="row" style="margin-top:10px"><button data-solonext>Дальше</button><button class="ghost" data-soloback>Назад</button></div>`;
  } else {
    solo.msg ||= draftCalm();
    const harsh = REPROACH.test(solo.msg);
    body = `<h1>💌 Спокойное сообщение</h1>
      <p class="muted">Одно сообщение ${esc(S.partner.name)}: о себе, без упрёков. Поправьте, как вам ближе.</p>
      <textarea id="solomsg" maxlength="1000">${esc(solo.msg)}</textarea>
      <p class="muted harsh" id="harsh" ${harsh ? '' : 'hidden'}>Некоторые слова могут прозвучать как упрёк («ты всегда», «из-за тебя»). Попробуйте сказать о себе: «мне», «я чувствую», «мне важно». Но решаете вы.</p>
      <div class="row" style="margin-top:10px"><button data-solosend>Отправить</button><button class="ghost" data-soloback>Назад</button></div>`;
  }
  $app.innerHTML = `<div class="card talk">${bar}${body}</div><button class="ghost" data-soloclose>Выйти</button>`;
  const imp = document.getElementById('soloimp');
  if (imp) imp.oninput = () => (solo.important = imp.value);
  const m = document.getElementById('solomsg');
  if (m) m.oninput = () => { solo.msg = m.value; document.getElementById('harsh').hidden = !REPROACH.test(m.value); };
}

function draftCalm() {
  const f = solo.feels.length ? `Мне сейчас ${solo.feels.join(' и ')}.` : 'Мне сейчас непросто.';
  const imp = solo.important.trim() ? ` Мне важно, ${solo.important.trim().replace(/^мне важно,?\s*/i, '').replace(/\.$/, '')}.` : '';
  return `${f}${imp} Я не хочу ссориться, я хочу, чтобы мы поговорили спокойно.`;
}

function renderSafety() {
  const h = config.help;
  document.getElementById('tabs').hidden = true;
  $app.innerHTML = `<div class="card safety"><h1>🤍 ${esc(h.title)}</h1>
    <p>${esc(h.text)}</p>
    ${h.contacts.map((c) => `<div class="contact"><span class="muted">${esc(c.label)}</span><b>${esc(c.value)}</b></div>`).join('')}
    <p class="muted" style="margin-top:10px">${esc(h.outside)}</p>
    <p class="muted">Игра не решает, кто прав, и не заменяет психолога.</p></div>
    <button class="ghost" data-safeok>Я в безопасности, вернуться к игре</button>`;
}

async function onSignalClick(e) {
  const el = e.target.closest('[data-sigopen],[data-sclose],[data-stime],[data-ssend],[data-rpick],[data-rcancel],[data-rtime],[data-rsend],[data-stepsave],[data-ideasclose],[data-mk],[data-mksave],[data-mkskip],[data-solo],[data-solotemp],[data-feelpick],[data-solonext],[data-soloback],[data-solosend],[data-soloclose],[data-safeok],[data-deep],[data-resume],[data-saynow],[data-back],[data-moreopen],[data-mtime],[data-more]');
  if (!el) return;
  e.preventDefault();
  const d = el.dataset;
  const keep = () => {
    const n = document.getElementById('signote'); if (n && sigForm) sigForm.note = n.value;
    const r = document.getElementById('sigrnote'); if (r && sigReply) sigReply.note = r.value;
    const st = document.getElementById('mstep'); if (st) stepDraft = st.value;
    const mk = document.getElementById('mkown'); if (mk && makeupDraft) makeupDraft.own = mk.value;
  };
  keep();
  try {
    if ('sigopen' in d) { sigForm = { kind: d.sigopen, note: '', time: config.signals[d.sigopen].time ? '60' : null }; tab = 'game'; }
    else if ('sclose' in d) sigForm = null;
    else if ('stime' in d) sigForm.time = d.stime;
    else if ('ssend' in d) {
      await api('/api/signal', { kind: sigForm.kind, note: sigForm.note, time: sigForm.time });
      haptic('medium'); toast(`Отправлено ${S.partner.name} 🤍`); sigForm = null; view = 'home'; return refresh(true);
    } else if ('rpick' in d) {
      const [id, key] = d.rpick.split(':');
      const s = S.signals.pending.find((x) => x.id === id);
      const r = s.replies.find((x) => x.key === key);
      sigReply = { id, key, time: r.time ? '60' : null, note: '' };
      if (!r.time && !['tell', 'thanks', 'back', 'forgive'].includes(key)) return sendReply();
    } else if ('rcancel' in d) sigReply = null;
    else if ('rtime' in d) sigReply.time = d.rtime;
    else if ('rsend' in d) return sendReply();
    else if ('stepsave' in d) {
      if (!stepDraft.trim()) return toast('Напишите маленький шаг');
      await api('/api/signal/step', { id: S.signals.step.id, step: stepDraft }); stepDraft = ''; haptic('medium'); toast('Шаг сохранён 🤝'); return refresh(true);
    } else if ('ideasclose' in d) lastIdeas = null;
    else if ('mk' in d) { const k = makeupDraft.keys; makeupDraft.keys = k.includes(d.mk) ? k.filter((x) => x !== d.mk) : [...k, d.mk]; }
    else if ('mksave' in d) { await api('/api/profile', { makeup: makeupDraft.keys, makeupOwn: makeupDraft.own }); makeupDraft = null; toast('Сохранено 🤍'); return refresh(true); }
    else if ('mkskip' in d) { await api('/api/profile', { makeup: [] }); makeupDraft = null; return refresh(true); }
    else if ('solo' in d) { solo = { step: 1, temp: null, feels: [], important: '', msg: '' }; tab = 'game'; }
    else if ('solotemp' in d) solo.temp = Number(d.solotemp);
    else if ('feelpick' in d) solo.feels = solo.feels.includes(d.feelpick) ? solo.feels.filter((x) => x !== d.feelpick) : [...solo.feels, d.feelpick].slice(-3);
    else if ('solonext' in d) { if (solo.step === 2) solo.msg = ''; solo.step += 1; }
    else if ('soloback' in d) solo.step -= 1;
    else if ('soloclose' in d) solo = null;
    else if ('solosend' in d) {
      if (!solo.msg.trim()) return toast('Напишите сообщение');
      await api('/api/signal', { kind: 'calm', note: solo.msg }); solo = null; haptic('medium');
      toast(`Отправлено. ${S.partner.name} получит ваше сообщение 💌`); return refresh(true);
    } else if ('safeok' in d) { await api('/api/safety/ok', {}); S.me.safety = false; return refresh(true); }
    else if ('deep' in d) { await api('/api/talk/deep', { on: true }); toast('Говорим о теме целиком 🔁'); library = { tone: null, items: [] }; return refresh(true); }
    else if ('resume' in d) { await api('/api/talk/resume', {}); toast('Продолжаем 🕊'); return refresh(true); }
    else if ('saynow' in d) { compose = freshCompose('say'); view = 'talk'; }
    else if ('moreopen' in d) moreTimePick = '60';
    else if ('mtime' in d) moreTimePick = d.mtime;
    else if ('more' in d) { await api('/api/signal/more', { id: d.more, time: moreTimePick }); toast(`Хорошо, напомним ${config.times[moreTimePick]} 🌬`); moreTimePick = null; return refresh(true); }
    else if ('back' in d) { await api('/api/signal/more', { id: d.back, back: true }); toast('Продолжаем 🕊'); moreTimePick = null; return refresh(true); }
    haptic(); render();
  } catch (err) { toast(err.message); }
}

async function sendReply() {
  const r = await api('/api/signal/reply', { id: sigReply.id, reply: sigReply.key, note: sigReply.note, time: sigReply.time })
    .catch((e) => { toast(e.message); return null; });
  if (!r) return;
  sigReply = null; haptic('medium');
  if (r.ideas) lastIdeas = [...r.ideas].sort(() => Math.random() - 0.5).slice(0, 3);
  if (r.talk && !S.talk) { talkForm = { topic: null, temp: null }; view = 'talk'; }
  toast(r.talk ? 'Отвечено. Выберите тему и начнём 🕊' : 'Ответ отправлен 🤍');
  refresh(true);
}

$app.addEventListener('click', onSignalClick);

(async function init() {
  config = await fetch('/api/config').then((r) => r.json());
  if (!inTelegram && config.demo) {
    const bar = document.getElementById('demo-bar');
    bar.hidden = false;
    const mark = () => bar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.demo === demoUser));
    mark();
    bar.onclick = (e) => {
      const b = e.target.closest('[data-demo]'); if (!b) return;
      demoUser = b.dataset.demo; localStorageSet('demoUser', demoUser); mark();
      compose = freshCompose(); sigForm = null; sigReply = null; solo = null; lastIdeas = null;
      answer = { text: '', rating: null }; sideDraft = null; msgDraft = null; dailyDraft = ''; feelPick = null; talkForm = null; summary = null; showSummary = false; replyDraft = ''; letterDraft = null; library = { tone: null, items: [] }; tab = 'game';
      refresh(true);
    };
  }
  await refresh(true);
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 4000);
})();
