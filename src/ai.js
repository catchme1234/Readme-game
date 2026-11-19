// ИИ-помощник: знает обе стороны ситуации, но никогда не раскрывает
// одному партнёру то, что другой написал наедине.
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { LIBRARY, TONES } from './library.js';

const client = process.env.ANTHROPIC_API_KEY ? new Anthropic() : null;
export const aiEnabled = Boolean(client);

const Suggestions = z.object({
  questions: z.array(z.string()).describe('Ровно 3 вопроса на русском языке'),
});

const SYSTEM = `Ты бережный помощник для пары, которая застряла в конфликте или тупике.
Партнёры по очереди задают друг другу вопросы. Ты предлагаешь вопросы тому, чей сейчас ход.

Тебе доступны «стороны» обоих партнёров: каждый рассказал тебе свою версию наедине.
Строгие правила конфиденциальности:
- Никогда не цитируй, не пересказывай и не намекай на конкретные детали, которые написал партнёр, получающий вопросы, или сам задающий. Вопрос будет прочитан обоими.
- Используй стороны только чтобы понять, какие темы и потребности стоит мягко открыть.
- Не принимай ничью сторону, не обвиняй, не ставь диагнозов.

Как писать вопросы:
- Открытые (не да/нет), короткие (до 25 слов), от первого лица задающего, обращение на «ты».
- Строго в заданном тоне. Мягкий: бережно и без давления. Игривый: легко, с юмором и теплом, снимает напряжение. Глубокий: о чувствах, потребностях, страхах и смыслах.
- Учитывай, какие вопросы получатель уже оценил высоко или низко, и не повторяй уже заданные.
- Если в сторонах есть признаки насилия или угрозы безопасности, не предлагай игровые вопросы, а мягко предложи вопрос о безопасности и поддержке.

Верни ровно 3 разных вопроса на русском языке.`;

function fallback(tone, asked) {
  const pool = LIBRARY[tone].filter((q) => !asked.includes(q));
  const src = pool.length >= 3 ? pool : LIBRARY[tone];
  return [...src].sort(() => Math.random() - 0.5).slice(0, 3);
}

/**
 * @param {object} p
 * @param {string} p.tone           тон вопросов
 * @param {object} p.asker          { name, situation }
 * @param {object} p.receiver       { name, situation, tone }
 * @param {Array}  p.history        [{from, text, answer, rating, tone}]
 */
export async function suggestQuestions({ tone, asker, receiver, history }) {
  const asked = history.map((h) => h.text);
  if (!client) return { questions: fallback(tone, asked), source: 'library' };

  const hist = history.slice(-12).map((h) =>
    `- ${h.fromName} спросил(а): «${h.text}» [тон: ${TONES[h.tone]?.label || '—'}]` +
    (h.rating ? ` оценка: ${h.rating}` : '') +
    (h.answer ? `\n  ответ: «${h.answer.slice(0, 400)}»` : ''),
  ).join('\n') || 'Пока вопросов не было.';

  const content = `Ход у: ${asker.name}. Вопрос получит: ${receiver.name}.
Нужный тон: ${TONES[tone].label}. ${receiver.name} предпочитает тон: ${TONES[receiver.tone]?.label || 'не указан'}.

<сторона_${asker.name} конфиденциально>
${asker.situation || '(не заполнено)'}
</сторона_${asker.name}>

<сторона_${receiver.name} конфиденциально>
${receiver.situation || '(не заполнено)'}
</сторона_${receiver.name}>

История вопросов и ответов (ответы оба партнёра уже видели):
${hist}

Предложи 3 вопроса, которые ${asker.name} может задать ${receiver.name}.`;

  try {
    const res = await client.messages.parse({
      model: process.env.CLAUDE_MODEL || 'claude-opus-5-5',
      max_tokens: 4000,
      output_config: { effort: 'low', format: zodOutputFormat(Suggestions) },
      system: SYSTEM,
      messages: [{ role: 'user', content }],
    });
    const qs = res.stop_reason === 'refusal' ? null : res.parsed_output?.questions;
    if (!qs?.length) return { questions: fallback(tone, asked), source: 'library' };
    return { questions: qs.slice(0, 3), source: 'ai' };
  } catch (e) {
    console.error('AI error:', e?.status, e?.message);
    return { questions: fallback(tone, asked), source: 'library' };
  }
}
