const tg = window.Telegram?.WebApp;
const inTelegram = Boolean(tg?.initData);
if (inTelegram) { tg.ready(); tg.expand(); document.documentElement.classList.add('tg'); }

const $app = document.getElementById('app');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let config = { tones: {} };
let S = null;            // состояние с сервера
let lastJson = '';
let tab = 'game';
let demoUser = localStorageGet('demoUser') || 'demoA';
// Черновики живут здесь, чтобы обновления не стирали набранный текст.
let compose = { mode: 'own', tone: null, text: '', picked: null, suggestions: null, loading: false, source: 'own' };
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
  if (!r.ok) throw new Error(data.error || 'Ошибка сети');
  return data;
}

function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}
function haptic(type = 'light') { try { tg?.HapticFeedback?.impactOccurred(type); } catch {} }

const toneLabel = (t) => (config.tones[t] ? `${config.tones[t].emoji} ${config.tones[t].label}` : 'не выбран');
const srcLabel = { own: '✍️ свой', library: '📚 из библиотеки', ai: '✨ от ИИ' };
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
  ({ game: renderGame, side: renderSide, tone: () => renderTonePick(false), history: renderHistory }[tab])();
}

function renderStart() {
  const join = new URLSearchParams(location.search).get('join') || '';
  $app.innerHTML = `
    <div class="card hero">
      <div class="big">💞</div>
      <h1>Вопросы для двоих</h1>
      <p class="muted">Когда разговор зашёл в тупик, задавайте друг другу вопросы по очереди. Свои, из библиотеки или подсказанные ИИ, который выслушал вас обоих.</p>
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
    </div>`;
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
    <div class="card hero"><div class="big">💌</div><h1>Пригласите партнёра</h1>
      <p class="muted">Игра начнётся, когда вы оба будете в паре.</p></div>
    <div class="card">
      <h2>Код пары</h2>
      <div class="code">${esc(S.pair.code)}</div>
      ${link ? '<button id="share">Отправить приглашение</button>' : '<p class="muted">Передайте этот код партнёру. В Telegram здесь будет кнопка «Отправить приглашение».</p>'}
      <button class="ghost" id="copy">Скопировать ${link ? 'ссылку' : 'код'}</button>
    </div>
    <div class="card"><button class="ghost" id="leave">Отменить пару</button></div>`;
  const text = 'Давай поиграем в вопросы друг другу 💞';
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
  if (o && o.to === S.me.id) return renderAnswer(o);
  if (o && o.from === S.me.id) {
    $app.innerHTML = `
      <div class="card hero"><div class="big">⏳</div><h1>Ждём ответ ${esc(S.partner.name)}</h1>
        <p class="muted">Мы пришлём уведомление в Telegram, когда ответ придёт.</p></div>
      <div class="card"><span class="badge">${toneLabel(o.tone)}</span><span class="badge">${srcLabel[o.source]}</span>
        <div class="question">${esc(o.text)}</div></div>
      ${sideHint()}`;
    return;
  }
  if (!S.pair.myTurn) {
    $app.innerHTML = `<div class="card hero"><div class="big">🤍</div><h1>Сейчас ход ${esc(S.partner.name)}</h1>
      <p class="muted">Скоро вам придёт вопрос.</p></div>${sideHint()}`;
    return;
  }
  renderCompose();
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
    <div class="card">
      <h1>Ваш ход ✨</h1>
      <p class="muted">Задайте ${esc(S.partner.name)} один вопрос. ${S.partner.tone ? `${esc(S.partner.name)} предпочитает тон ${toneLabel(S.partner.tone)}.` : ''}</p>
      <div class="modes">
        <button data-mode="own" class="${m === 'own' ? 'on' : ''}"><span>✍️</span>Свой</button>
        <button data-mode="library" class="${m === 'library' ? 'on' : ''}"><span>📚</span>Библиотека</button>
        <button data-mode="ai" class="${m === 'ai' ? 'on' : ''}"><span>✨</span>ИИ</button>
      </div>
      ${m !== 'own' ? `<div class="chips">${tones.map(([k, t]) => `<button class="chip ${compose.tone === k ? 'on' : ''}" data-ctone="${k}">${t.emoji} ${t.label}</button>`).join('')}</div>` : ''}
      <div id="pane"></div>
    </div>
    ${sideHint()}`;
  const pane = document.getElementById('pane');

  if (m === 'own') {
    pane.innerHTML = `
      <textarea id="qtext" placeholder="Например: Что тебе было бы важно услышать от меня сейчас?">${esc(compose.text)}</textarea>
      <div class="chips">${tones.map(([k, t]) => `<button class="chip ${compose.tone === k ? 'on' : ''}" data-ctone="${k}">${t.emoji} ${t.label}</button>`).join('')}</div>
      <button id="send">Отправить вопрос</button>`;
  } else if (m === 'library') {
    if (library.tone !== compose.tone) { loadLibrary(); pane.innerHTML = '<p class="muted">Загрузка…</p>'; }
    else pane.innerHTML = `<div class="qlist">${library.items.map((q, i) =>
      `<button data-pick="${i}" class="${compose.picked === q.text ? 'on' : ''} ${q.asked ? 'asked' : ''}">${esc(q.text)}${q.asked ? ' <span class="muted">(уже был)</span>' : ''}</button>`).join('')}</div>
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
  return `<p class="muted" style="margin-top:8px">Можно поправить своими словами:</p>
    <textarea id="qtext">${esc(compose.text)}</textarea><button id="send">Отправить вопрос</button>`;
}

async function loadLibrary() {
  const tone = compose.tone;
  const r = await api(`/api/library?tone=${tone}`);
  library = { tone, items: r.questions };
  if (tab === 'game') renderCompose();
}

function bindCompose() {
  $app.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
    compose.mode = b.dataset.mode; compose.picked = null;
    if (compose.mode === 'own') compose.text = '';
    renderCompose();
  }));
  $app.querySelectorAll('[data-ctone]').forEach((b) => (b.onclick = () => {
    compose.tone = b.dataset.ctone; if (compose.mode !== 'own') { compose.picked = null; compose.suggestions = null; }
    renderCompose();
  }));
  $app.querySelectorAll('[data-pick]').forEach((b) => (b.onclick = () => {
    compose.picked = compose.text = library.items[b.dataset.pick].text; compose.source = 'library'; renderCompose();
  }));
  $app.querySelectorAll('[data-sug]').forEach((b) => (b.onclick = () => {
    compose.picked = compose.text = compose.suggestions[b.dataset.sug]; renderCompose();
  }));
  const ta = document.getElementById('qtext');
  if (ta) ta.oninput = () => (compose.text = ta.value);
  const gen = document.getElementById('gen');
  if (gen) gen.onclick = async () => {
    compose.loading = true; compose.picked = null; renderCompose();
    try {
      const r = await api('/api/ai/suggest', { tone: compose.tone });
      compose.suggestions = r.questions; compose.source = r.source;
    } catch (e) { toast(e.message); }
    compose.loading = false; renderCompose();
  };
  const send = document.getElementById('send');
  if (send) send.onclick = async () => {
    const source = compose.mode === 'own' ? 'own' : compose.mode === 'library' ? 'library' : compose.source;
    try {
      send.disabled = true;
      await api('/api/question', { text: compose.text, tone: compose.tone, source });
      haptic('medium'); toast('Вопрос отправлен 💌');
      compose = { mode: compose.mode, tone: null, text: '', picked: null, suggestions: null, loading: false, source: 'own' };
      refresh(true);
    } catch (e) { toast(e.message); send.disabled = false; }
  };
}

function renderAnswer(o) {
  $app.innerHTML = `
    <div class="card">
      <p class="muted">${esc(o.fromName)} спрашивает:</p>
      <div class="question">${esc(o.text)}</div>
      <span class="badge">${toneLabel(o.tone)}</span><span class="badge">${srcLabel[o.source]}</span>
    </div>
    <div class="card">
      <h2>Ваш ответ</h2>
      <textarea id="atext" placeholder="Ответьте честно, как чувствуете">${esc(answer.text)}</textarea>
      <p class="muted" style="margin-top:12px">Как вам этот вопрос? Так ${esc(o.fromName)} поймёт, какие вопросы вам ближе.</p>
      <div class="rating">${Object.entries(rateLabel).map(([k, l]) => `<button data-rate="${k}" class="${answer.rating === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      <button id="send">Ответить</button>
    </div>`;
  const ta = document.getElementById('atext');
  ta.oninput = () => (answer.text = ta.value);
  $app.querySelectorAll('[data-rate]').forEach((b) => (b.onclick = () => { answer.rating = b.dataset.rate; haptic(); renderAnswer(o); }));
  document.getElementById('send').onclick = async () => {
    try {
      await api('/api/answer', { answer: answer.text, rating: answer.rating });
      answer = { text: '', rating: null }; haptic('medium'); toast('Ответ отправлен. Теперь ваш ход ✨');
      refresh(true);
    } catch (e) { toast(e.message); }
  };
}

function renderSide() {
  $app.innerHTML = `
    <div class="card">
      <h1>🔒 Моя сторона</h1>
      <div class="private"><span>👁️</span><span>Этот текст видит <b>только ИИ-помощник</b>. ${esc(S.partner.name)} его не увидит, и ИИ не будет его пересказывать.</span></div>
      <p class="muted">Что произошло, что вы чувствуете, чего хотите и чего боитесь. Пишите как есть.</p>
      <textarea id="side" style="min-height:220px" maxlength="4000" placeholder="Например: мы спорим о том, как проводить выходные. Мне обидно, что…">${esc(sideDraft)}</textarea>
      <button id="save" style="margin-top:10px">Сохранить</button>
      ${S.me.situation ? '<button class="ghost" id="clear">Удалить мой текст</button>' : ''}
    </div>
    <div class="card"><p class="muted">${esc(S.partner.name)} ${S.partner.sideFilled ? 'уже рассказал(а) свою сторону.' : 'пока не рассказал(а) свою сторону.'}</p></div>`;
  const ta = document.getElementById('side');
  ta.oninput = () => (sideDraft = ta.value);
  document.getElementById('save').onclick = async () => { await api('/api/profile', { situation: sideDraft }); toast('Сохранено 🔒'); refresh(true); };
  const clear = document.getElementById('clear');
  if (clear) clear.onclick = async () => { sideDraft = ''; await api('/api/profile', { situation: '' }); refresh(true); };
}

function renderHistory() {
  const h = S.history;
  $app.innerHTML = `<h1 style="padding:0 4px 8px">📖 История</h1>` + (h.length ? h.map((q) => `
    <div class="card hist">
      <p class="muted">${esc(q.fromName)} → ${q.from === S.me.id ? esc(S.partner.name) : 'вам'} · ${new Date(q.createdAt).toLocaleDateString('ru-RU')}</p>
      <b>${esc(q.text)}</b>
      <div class="a">${esc(q.answer)}</div>
      <p style="margin-top:8px"><span class="badge">${toneLabel(q.tone)}</span><span class="badge">${srcLabel[q.source]}</span>${q.rating ? `<span class="badge">${rateLabel[q.rating]}</span>` : ''}</p>
    </div>`).join('') : '<div class="card center muted">Здесь появятся ваши вопросы и ответы.</div>');
}

// ---------- Навигация ----------
document.getElementById('tabs').onclick = (e) => {
  const b = e.target.closest('[data-tab]'); if (!b) return;
  tab = b.dataset.tab; render();
};
$app.addEventListener('click', (e) => {
  const g = e.target.closest('[data-go]'); if (g) { tab = g.dataset.go; render(); }
});

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
      compose = { mode: 'own', tone: null, text: '', picked: null, suggestions: null, loading: false, source: 'own' };
      answer = { text: '', rating: null }; sideDraft = null; library = { tone: null, items: [] }; tab = 'game';
      refresh(true);
    };
  }
  await refresh(true);
  setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 4000);
})();
