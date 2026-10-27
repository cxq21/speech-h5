// 文本后处理规则层（浏览器即时生效；Node 测试共用）：分句、分段、表情、知识库解析与 BM25 检索、术语纠错
export const TRANSITION = /^(然后|另外|对了|还有|接下来|首先|其次|最后|总之|总的来说|所以说|话说回来|另一方面|此外|不过|但是呢|那么|换个话题|说到|顺便说一下)/;
const END = /[。！？!?；;…]+[”"’）)]*$/;

// 把一段最终文本切成句子（保留句末标点）
export function splitSentences(text) {
  const out = []; let cur = '';
  for (const ch of String(text || '')) {
    cur += ch;
    if (/[。！？!?；;]/.test(ch)) { out.push(cur); cur = ''; }
    else if (/[”"’）)]/.test(ch) && out.length && cur.length === 1) { out[out.length - 1] += ch; cur = ''; }
  }
  if (cur.trim()) out.push(cur);
  return out.map((s) => s.trim()).filter(Boolean);
}

// 规则分段：长停顿 / 话题转折词 / 段落句数或字数上限
export function ruleBreak(sentence, para, { gapMs = 0, longPauseMs = 2500, maxSentences = 4, maxChars = 120 } = {}) {
  if (!para || para.count === 0) return false;
  if (gapMs >= longPauseMs) return true;
  if (TRANSITION.test(sentence)) return true;
  return para.count >= maxSentences || para.chars + sentence.length > maxChars;
}

// 规则表情：关键词 → emoji；克制：每句最多 1 个，前 2 句有表情时只有带感叹的句子才加
const EMOJI_RULES = [
  [/恭喜|祝贺|生日快乐|庆祝|新年快乐/, '🎉'], [/谢谢|感谢|辛苦了|麻烦你了/, '🙏'], [/哈哈|太好了|好开心|真开心|高兴|太棒了/, '😄'],
  [/难过|伤心|遗憾|可惜|心疼/, '😢'], [/生气|气死|烦死|受不了/, '😠'], [/加油|冲啊|努力|拼了/, '💪'], [/爱你|喜欢你|想你|么么/, '❤️'],
  [/晴天|太阳|天气很好|天气不错|天气好/, '☀️'], [/下雨|雨天|带伞/, '🌧️'], [/火锅|好吃|美食|毛豆腐|臭鳜鱼|烧饼|吃饭|宵夜/, '🍲'],
  [/会议|开会/, '📅'], [/增长|提升|上涨|涨了/, '📈'], [/下降|下跌|跌了/, '📉'], [/注意|小心|千万别|警告/, '⚠️'],
  [/爬山|旅游|出发|逛逛|老街|古村/, '🏞️'], [/晚安|睡觉了/, '🌙'], [/早上好|早安/, '🌅'], [/奇怪|为什么|怎么回事/, '🤔'],
];
export function ruleEmoji(sentence, recentHadEmoji = false) {
  const strong = /[！!]/.test(sentence);
  if (recentHadEmoji && !strong) return '';
  for (const [re, e] of EMOJI_RULES) if (re.test(sentence)) return e;
  return '';
}
// 把 emoji 放到句末标点之后
export function withEmoji(text, emoji) { return emoji ? text + emoji : text; }
export const EMOJI_RE = /(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})(?:\uFE0F|\u200D(?:\p{Extended_Pictographic}|\p{Emoji_Presentation})\uFE0F?)*/gu;
export const stripEmoji = (s) => String(s || '').replace(EMOJI_RE, '');

// ---------- 知识库 ----------
// 支持：普通段落（检索用）；术语行「术语」「术语：解释」「术语 - 解释」；纠错行「错写→正写」「错写=>正写」
export function parseKB(text) {
  const terms = new Set(), fixes = [], paras = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim(); if (!line) { paras.push(''); continue; }
    const fx = line.match(/^(.{1,20}?)\s*(?:→|->|=>)\s*(.{1,20})$/);
    if (fx) { fixes.push([fx[1].trim(), fx[2].trim()]); terms.add(fx[2].trim()); continue; }
    const tm = line.match(/^([^：:，,。\s][^：:，,。]{0,15}?)\s*(?:[：:]|\s-\s|——)\s*\S/);
    if (tm) terms.add(tm[1].trim());
    else if (line.length <= 12 && !/[。！？，,]/.test(line)) { for (const t of line.split(/[、|，,\s]+/)) if (t) terms.add(t); continue; }
    else if (/^[^。！？]{1,60}$/.test(line) && /[、|]/.test(line)) { for (const t of line.split(/[、|]+/)) if (t.trim() && t.trim().length <= 16) terms.add(t.trim()); continue; }
    paras.push(line);
  }
  // 切片：按段落累积到 ~200 字
  const chunks = []; let cur = '';
  for (const p of paras) {
    if (!p) { if (cur) { chunks.push(cur); cur = ''; } continue; }
    if (cur.length + p.length > 200 && cur) { chunks.push(cur); cur = ''; }
    cur += (cur ? '\n' : '') + p;
    while (cur.length > 300) { chunks.push(cur.slice(0, 200)); cur = cur.slice(180); }
  }
  if (cur) chunks.push(cur);
  return { terms: [...terms].filter((t) => t.length >= 2 && t.length <= 16), fixes, chunks, index: buildBM25(chunks) };
}

const tokens = (s) => { const c = [...String(s).replace(/[\s\p{P}]/gu, '')]; const out = [...c]; for (let i = 0; i + 1 < c.length; i++) out.push(c[i] + c[i + 1]); return out; };
export function buildBM25(docs) {
  const tf = docs.map((d) => { const m = new Map(); for (const t of tokens(d)) m.set(t, (m.get(t) || 0) + 1); return m; });
  const df = new Map(); tf.forEach((m) => m.forEach((_, t) => df.set(t, (df.get(t) || 0) + 1)));
  const len = tf.map((m) => [...m.values()].reduce((a, b) => a + b, 0)); const avg = len.reduce((a, b) => a + b, 0) / (len.length || 1);
  return { docs, tf, df, len, avg, N: docs.length };
}
export function searchBM25(ix, query, k = 3, k1 = 1.2, b = 0.75) {
  if (!ix || !ix.N) return [];
  const q = [...new Set(tokens(query))];
  const scores = ix.tf.map((m, i) => q.reduce((s, t) => {
    const f = m.get(t); if (!f) return s;
    const idf = Math.log(1 + (ix.N - ix.df.get(t) + 0.5) / (ix.df.get(t) + 0.5)) * (t.length > 1 ? 1.5 : 1);
    return s + idf * f * (k1 + 1) / (f + k1 * (1 - b + b * ix.len[i] / ix.avg));
  }, 0));
  return scores.map((s, i) => [s, i]).filter(([s]) => s > 0).sort((x, y) => y[0] - x[0]).slice(0, k).map(([s, i]) => ({ score: s, text: ix.docs[i] }));
}
// 与句子相关的术语：共享任一字（同音错字往往只差一个字）且总数受限
export function relevantTerms(terms, text, max = 40) {
  const chars = new Set([...text]);
  const scored = terms.map((t) => [[...t].filter((c) => chars.has(c)).length, t]).filter(([n]) => n > 0).sort((a, b) => b[0] - a[0]);
  return scored.slice(0, max).map(([, t]) => t);
}
export function applyFixes(text, fixes) { let s = text; for (const [a, b] of fixes || []) if (a) s = s.split(a).join(b); return s; }
// 讯飞会话热词：≤1024 字节
export function hotwordList(terms, maxBytes = 1000) {
  const out = []; let bytes = 6;
  for (const t of terms) { const n = new TextEncoder().encode(t).length + 1; if (bytes + n > maxBytes) break; out.push(t); bytes += n; }
  return out;
}

// 润色结果校验：去掉 emoji/标点后编辑距离 ≤ 30%（只允许纠错，不允许改写）
export function editDistance(a, b) {
  const A = [...a], B = [...b]; let d = Array.from({ length: B.length + 1 }, (_, j) => j);
  for (let i = 1; i <= A.length; i++) { const nd = [i]; for (let j = 1; j <= B.length; j++) nd[j] = Math.min(d[j] + 1, nd[j - 1] + 1, d[j - 1] + (A[i - 1] === B[j - 1] ? 0 : 1)); d = nd; }
  return d[B.length];
}
const core = (s) => stripEmoji(s).replace(/[\s\p{P}]/gu, '');
export function acceptablePolish(orig, polished, maxRatio = 0.3) {
  const a = core(orig), b = core(polished);
  if (!b) return false;
  return editDistance(a, b) <= Math.max(2, Math.ceil(a.length * maxRatio));
}
