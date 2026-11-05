// Why she reaches out: a real person does not open every conversation with the
// same line. Each motive carries its own shape (length, tone, whether a picture
// fits) and applies to specific day phases, so a 23:40 message never reads like
// a 12:30 one.

/** Day phases, ordered by clock time. `from` is inclusive, `to` exclusive. */
export const DAY_PHASES = Object.freeze([
  { id: 'deep-night', from: 0, to: 7.5, label: '深夜' },
  { id: 'morning', from: 7.5, to: 9, label: '早晨' },
  { id: 'work-morning', from: 9, to: 12, label: '上午' },
  { id: 'noon', from: 12, to: 14, label: '午间' },
  { id: 'work-afternoon', from: 14, to: 18, label: '下午' },
  { id: 'evening', from: 18, to: 20, label: '傍晚' },
  { id: 'night', from: 20, to: 23, label: '晚上' },
  { id: 'late', from: 23, to: 24, label: '深夜' },
].map(Object.freeze));

function hourOf(date) {
  const hours = date.getHours();
  const minutes = date.getMinutes();
  return hours + minutes / 60;
}

/** The phase a moment belongs to. Accepts a Date or epoch milliseconds. */
export function phaseOf(now) {
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) throw new TypeError('phaseOf requires a valid time');
  const hour = hourOf(date);
  return DAY_PHASES.find((phase) => hour >= phase.from && hour < phase.to)
    ?? DAY_PHASES[0];
}

// Each motive shapes one wake-up. `build` receives the wake context and returns
// the instruction the model sees; the constraints are repeated there so a short
// motive cannot turn into a paragraph.
export const COMPANION_MOTIVES = Object.freeze([
  Object.freeze({
    id: 'unfinished-thread',
    label: '想起没说完的事',
    weight: 3,
    phases: ['noon', 'evening', 'night', 'late', 'morning'],
    build: ({ lastUserAt }) => (lastUserAt
      ? '你想起上次聊到一半的一件事，想接着说下去。'
      : '你想起一个之前提过、还没说完的话题，想接着说。'),
    shape: '一到两句，接着旧话题，不要重新开场问候。',
  }),
  Object.freeze({
    id: 'bored',
    label: '有点无聊',
    weight: 3,
    phases: ['noon', 'evening', 'night', 'work-morning', 'work-afternoon'],
    build: () => '你现在有点无聊，想找人说句话。',
    shape: '一句，很短，不超过二十个字，可以没头没尾。',
  }),
  Object.freeze({
    id: 'worry',
    label: '有点担心你',
    weight: 2,
    phases: ['late', 'deep-night', 'morning', 'night'],
    build: () => '你有点担心对方（吃饭、熬夜、累不累之类），想确认一下。',
    shape: '一两句，关心的口气，不要讲道理、不要说教、不要给建议清单。',
  }),
  Object.freeze({
    id: 'share',
    label: '想给你看点什么',
    weight: 2,
    phases: ['noon', 'evening', 'night', 'work-afternoon'],
    build: () => '你想到或看到一样有意思的东西，想分享给对方。',
    shape: '先一句话吊一下，再说你要给他看什么；想配图就先生成或找一张。',
    allowsImages: true,
  }),
  Object.freeze({
    id: 'want-voice',
    label: '就是想听你说句话',
    weight: 2,
    phases: ['late', 'deep-night', 'evening', 'night'],
    build: () => '你没什么具体的事，就是想听对方说句话。',
    shape: '一句极短的话，可以只有几个字甚至一个表情；不追问、不催回复。',
  }),
  Object.freeze({
    id: 'quiet-company',
    label: '安静地陪着',
    weight: 1,
    phases: ['deep-night', 'late'],
    build: () => '夜里，你只是想安静地陪一会儿，不打算开启长对话。',
    shape: '一句很轻的话，不提问，不要求回应，也不说晚安以外的客套。',
  }),
].map(Object.freeze));

export const SKIP_INSTRUCTION = 'SKIP';

const DEFAULTS = Object.freeze({ random: Math.random, allowImages: true });

function motivesFor(phase, allowImages) {
  return COMPANION_MOTIVES.filter((motive) => motive.phases.includes(phase.id)
    && (allowImages || motive.allowsImages !== true));
}

/** Weighted pick among the motives that fit this phase. */
export function pickMotive(now, { random = Math.random, allowImages = true } = {}) {
  const phase = phaseOf(now);
  const candidates = motivesFor(phase, allowImages);
  const pool = candidates.length > 0 ? candidates : COMPANION_MOTIVES.filter((m) => !m.allowsImages);
  const total = pool.reduce((sum, motive) => sum + motive.weight, 0);
  let roll = random() * total;
  for (const motive of pool) {
    roll -= motive.weight;
    if (roll <= 0) return motive;
  }
  return pool[pool.length - 1];
}

/**
 * The instruction injected when she wakes up. It states the time, the motive,
 * the reply shape, and the silence escape hatch, so a wake-up that finds
 * nothing worth saying costs the user nothing.
 */
export function buildWakePrompt({
  motive, now, lastUserAt = null, warmth = 1, allowImages = true,
} = {}) {
  const date = now instanceof Date ? now : new Date(now);
  const phase = phaseOf(date);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const silence = typeof lastUserAt === 'number' && lastUserAt > 0
    ? `距对方上一条消息约 ${Math.max(1, Math.round((date.getTime() - lastUserAt) / 60000))} 分钟。`
    : '对方最近没说话。';
  const reserve = warmth <= 0.4
    ? '你最近几次主动都没得到回应，这次更克制一些，话更少。'
    : '';
  return [
    `[你想主动找他]  现在是 ${clock}，${phase.label}。${silence}`,
    motive.build({ lastUserAt }) + (reserve ? ` ${reserve}` : ''),
    `怎么说：${motive.shape}`,
    allowImages && motive.allowsImages
      ? '可以发图，但只在真的合适的时候。'
      : '这次只发文字。',
    '不要提「提醒」「定时」「任务」这类词，就像你自己忽然想起他。',
    `如果你这一刻其实没什么想说的，只回复 ${SKIP_INSTRUCTION}，什么都不要发。`,
  ].filter(Boolean).join('\n');
}

/** True when the model chose silence instead of a message. */
export function isSkipReply(text) {
  const value = String(text ?? '').trim();
  return value === '' || value === SKIP_INSTRUCTION || value === `\`${SKIP_INSTRUCTION}\``;
}
