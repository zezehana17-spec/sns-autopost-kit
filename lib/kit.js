// SNS 자동 발행 키트 — 공용 코드 (외부 패키지 없음)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const VERSION = process.env.META_GRAPH_VERSION?.trim() || 'v26.0';
const FB = process.env.KIT_FB_BASE || 'https://graph.facebook.com';
const IG = process.env.KIT_IG_BASE || 'https://graph.instagram.com';
const TH = process.env.KIT_THREADS_BASE || 'https://graph.threads.net';
export const MAX_ATTEMPTS = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 시간 (한국 시간) ----------
export function kstStamp(ms = Date.now()) {
  const d = new Date(ms + 9 * 3600 * 1000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
}
export function parseKst(s) {
  if (!s) return 0;
  const m = String(s).trim().match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?$/);
  if (!m) return NaN;
  return Date.parse(`${m[1]}T${m[2] || '09:00'}:00+09:00`);
}

// ---------- 환경변수 (계정별) ----------
export function envFor(name, account = 'main') {
  const a = String(account || 'main').toUpperCase().replace(/[^A-Z0-9]/g, '_');
  return (process.env[`${name}_${a}`] || (a === 'MAIN' ? process.env[name] : '') || '').trim();
}
export function siteOrigin() {
  const s = process.env.SITE_URL?.trim() || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '');
  return s.replace(/\/$/, '');
}
export function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- 저장소: Upstash Redis REST (Vercel Marketplace에서 연결하면 환경변수가 자동으로 생김) ----------
function redisConf() {
  const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').trim();
  const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim();
  if (!url || !token) throw new Error('[STORE] 저장소(Upstash Redis)가 연결되지 않았어요. Vercel → Storage에서 연결하고 다시 배포해 주세요.');
  return { url: url.replace(/\/$/, ''), token };
}
async function redis(commands) {
  const { url, token } = redisConf();
  const r = await fetch(`${url}/pipeline`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(commands) });
  const j = await r.json().catch(() => null);
  if (!r.ok || !Array.isArray(j)) throw new Error(`[STORE] ${r.status} ${JSON.stringify(j).slice(0, 200)}`);
  return j.map((x) => { if (x.error) throw new Error(`[STORE] ${x.error}`); return x.result; });
}
export async function getStates(ids) {
  if (!ids.length) return {};
  const [vals] = await redis([['MGET', ...ids.map((id) => `post:${id}`)]]);
  const out = {};
  ids.forEach((id, i) => { out[id] = vals[i] ? JSON.parse(vals[i]) : {}; });
  return out;
}
export async function setState(id, state) {
  await redis([['SET', `post:${id}`, JSON.stringify({ ...state, updatedAt: kstStamp() })]]);
}
async function getKey(k) { const [v] = await redis([['GET', k]]); return v ? JSON.parse(v) : null; }
async function setKey(k, v) { await redis([['SET', k, JSON.stringify(v)]]); }

// ---------- 글 목록: outbox/*.json ----------
const CHANNELS = ['reel', 'card', 'threads'];
export function loadOutbox() {
  const dir = path.join(process.cwd(), 'outbox');
  const posts = [], problems = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { /* 폴더 없음 */ }
  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      const id = String(p.id || f.replace(/\.json$/, ''));
      const problem = checkPost({ ...p, id });
      if (problem) problems.push({ file: f, problem });
      else posts.push({ account: 'main', ...p, id, publishMs: parseKst(p.publishAt) });
    } catch (e) { problems.push({ file: f, problem: `JSON 오류: ${e.message}` }); }
  }
  posts.sort((a, b) => a.publishMs - b.publishMs || a.id.localeCompare(b.id));
  return { posts, problems };
}
const isMedia = (p) => typeof p === 'string' && /^\/media\/[\w-]+\/[\w.-]+\.(jpg|jpeg|png|mp4)$/i.test(p);
function checkPost(p) {
  if (!/^[\w-]{1,80}$/.test(p.id)) return 'id는 영문·숫자·-만 80자 이내';
  if (!CHANNELS.includes(p.channel)) return `channel은 ${CHANNELS.join('/')} 중 하나`;
  if (Number.isNaN(parseKst(p.publishAt))) return 'publishAt 형식은 "YYYY-MM-DD HH:MM"';
  if (p.channel === 'reel' && !(isMedia(p.video) && /\.mp4$/i.test(p.video))) return 'reel은 video에 /media/폴더/파일.mp4';
  if (p.channel === 'card') {
    if (!Array.isArray(p.images) || p.images.length < 2 || p.images.length > 10) return 'card는 images 2~10장';
    if (!p.images.every((x) => isMedia(x) && !/\.mp4$/i.test(x))) return 'card 이미지는 /media/폴더/파일.jpg';
  }
  if (p.channel === 'threads' && !String(p.body || '').trim()) return 'threads는 body 필요';
  return '';
}
const mediaUrl = (p) => `${siteOrigin()}${p}`;

// ---------- HTTP ----------
async function call(method, url, params, label) {
  const body = method === 'POST' ? new URLSearchParams(params) : undefined;
  const q = method === 'GET' ? `?${new URLSearchParams(params)}` : '';
  const r = await fetch(url + q, { method, body, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) {
    const m = j.error?.error_user_msg || j.error?.message || `HTTP ${r.status}`;
    throw new Error(`[${label}] ${m}`);
  }
  return j;
}

// ---------- 인스타그램 ----------
export function igTarget(account) {
  const token = envFor('IG_TOKEN', account);
  const userId = envFor('IG_USER_ID', account);
  if (!token) throw new Error(`[IG_TOKEN] ${account} 계정 인스타 토큰이 없어요 (IG_TOKEN${account === 'main' ? '' : `_${account.toUpperCase()}`})`);
  // EAA… = 메타 비즈니스(시스템 사용자) 토큰 → graph.facebook.com, IG… = 인스타 로그인 토큰 → graph.instagram.com
  const base = `${token.startsWith('IG') ? IG : FB}/${VERSION}`;
  return { token, userId: userId || 'me', base };
}
async function igStatus(t, id) {
  return call('GET', `${t.base}/${id}`, { fields: 'status_code,status', access_token: t.token }, 'IG_STATUS');
}
async function igPublish(t, creationId, caption) {
  const m = await call('POST', `${t.base}/${t.userId}/media_publish`, { creation_id: creationId, access_token: t.token }, 'IG_PUBLISH');
  let url = '';
  try { url = (await call('GET', `${t.base}/${m.id}`, { fields: 'permalink', access_token: t.token }, 'IG_LINK')).permalink || ''; } catch { /* 선택 */ }
  return { postId: m.id, url };
}
async function publishCard(post) {
  const t = igTarget(post.account);
  const children = [];
  for (const img of post.images) {
    const c = await call('POST', `${t.base}/${t.userId}/media`, { image_url: mediaUrl(img), is_carousel_item: 'true', access_token: t.token }, 'IG_CARD_ITEM');
    children.push(c.id);
  }
  const car = await call('POST', `${t.base}/${t.userId}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: post.caption || '', access_token: t.token }, 'IG_CAROUSEL');
  for (let i = 0; i < 10; i++) {
    const s = await igStatus(t, car.id);
    if (s.status_code === 'FINISHED') break;
    if (s.status_code === 'ERROR') throw new Error(`[IG_CAROUSEL] ${s.status || 'ERROR'}`);
    await sleep(3000);
  }
  return { done: true, ...(await igPublish(t, car.id)) };
}
// 릴스는 인스타가 영상을 처리하는 데 몇 분 걸려서, 실행 두 번에 나눠서 한다 (무료 Vercel 함수 시간 60초).
async function publishReel(post, st) {
  const t = igTarget(post.account);
  if (!st.container) {
    const c = await call('POST', `${t.base}/${t.userId}/media`, { media_type: 'REELS', video_url: mediaUrl(post.video), caption: post.caption || '', share_to_feed: 'true', access_token: t.token }, 'IG_REEL');
    return { done: false, container: c.id, containerAt: Date.now() };
  }
  const s = await igStatus(t, st.container);
  if (s.status_code === 'FINISHED') return { done: true, ...(await igPublish(t, st.container)) };
  if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`[IG_REEL] 영상 처리 실패: ${s.status || s.status_code}`);
  if (Date.now() - (st.containerAt || 0) > 30 * 60 * 1000) throw new Error('[IG_REEL] 30분 넘게 처리 중이라 멈췄어요');
  return { done: false, container: st.container, containerAt: st.containerAt };
}

// ---------- 스레드 ----------
const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const cryptKey = () => crypto.createHash('sha256').update(`kit-token:${process.env.CRON_SECRET || ''}`).digest();
function enc(s) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', cryptKey(), iv);
  const d = Buffer.concat([c.update(s, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), d]).toString('base64url');
}
function dec(s) {
  const raw = Buffer.from(s, 'base64url'), d = crypto.createDecipheriv('aes-256-gcm', cryptKey(), raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}
// 환경변수 토큰이 바뀌면 그걸 쓰고, 아니면 앱이 연장해 둔 토큰을 쓴다.
export async function threadsToken(account) {
  const envTok = envFor('THREADS_TOKEN', account);
  if (!envTok) throw new Error(`[THREADS_TOKEN] ${account} 계정 스레드 토큰이 없어요`);
  const saved = await getKey(`threads:${account}`);
  if (saved && saved.envHash === hash(envTok) && saved.enc) { try { return dec(saved.enc); } catch { /* 비밀값이 바뀜 */ } }
  return envTok;
}
// 일주일에 한 번 연장 (토큰 발급 24시간 뒤부터 가능, 60일 지나면 만료)
export async function refreshThreads(account) {
  const envTok = envFor('THREADS_TOKEN', account);
  if (!envTok) return { account, skipped: '토큰 없음' };
  const saved = await getKey(`threads:${account}`);
  const fresh = !saved || saved.envHash !== hash(envTok);
  if (fresh) { await setKey(`threads:${account}`, { envHash: hash(envTok), enc: '', firstSeen: Date.now(), refreshedAt: 0 }); return { account, skipped: '처음 봄, 24시간 뒤 연장' }; }
  const last = saved.refreshedAt || saved.firstSeen || 0;
  if (Date.now() - last < 7 * 24 * 3600 * 1000 && saved.refreshedAt) return { account, skipped: '최근에 연장함' };
  if (!saved.refreshedAt && Date.now() - (saved.firstSeen || 0) < 25 * 3600 * 1000) return { account, skipped: '24시간 대기' };
  try {
    const cur = await threadsToken(account);
    const r = await call('GET', `${TH}/refresh_access_token`, { grant_type: 'th_refresh_token', access_token: cur }, 'THREADS_REFRESH');
    await setKey(`threads:${account}`, { ...saved, enc: enc(r.access_token), refreshedAt: Date.now(), lastError: '' });
    return { account, refreshed: true, expiresInDays: Math.round((r.expires_in || 0) / 86400) };
  } catch (e) {
    await setKey(`threads:${account}`, { ...saved, lastError: e.message, lastTry: Date.now() });
    return { account, error: e.message };
  }
}
function splitThreads(text, max = 480) {
  const parts = [];
  let cur = '';
  for (const para of String(text).trim().split(/\n{2,}/)) {
    const add = cur ? `${cur}\n\n${para}` : para;
    if (add.length <= max) { cur = add; continue; }
    if (cur) parts.push(cur);
    if (para.length <= max) { cur = para; continue; }
    for (let i = 0; i < para.length; i += max) parts.push(para.slice(i, i + max));
    cur = '';
  }
  if (cur) parts.push(cur);
  return parts;
}
export async function publishThreadsText(account, text) {
  const token = await threadsToken(account);
  const base = `${TH}/v1.0`;
  let first = null, replyTo = null;
  for (const part of splitThreads(text)) {
    const p = { media_type: 'TEXT', text: part, access_token: token };
    if (replyTo) p.reply_to_id = replyTo;
    const c = await call('POST', `${base}/me/threads`, p, 'THREADS_CREATE');
    await sleep(1500);
    const m = await call('POST', `${base}/me/threads_publish`, { creation_id: c.id, access_token: token }, 'THREADS_PUBLISH');
    if (!first) first = m.id;
    replyTo = m.id;
  }
  let url = '';
  try { url = (await call('GET', `${base}/${first}`, { fields: 'permalink', access_token: token }, 'THREADS_LINK')).permalink || ''; } catch { /* 선택 */ }
  return { done: true, postId: first, url };
}

// ---------- 실행 ----------
export function isDue(post, now = Date.now()) {
  return !post.publishMs || post.publishMs <= now;
}
export async function runDue({ onlyId = '', force = false, limit = 3 } = {}) {
  const { posts, problems } = loadOutbox();
  const states = await getStates(posts.map((p) => p.id));
  const results = [];
  let handled = 0;
  for (const post of posts) {
    if (onlyId && post.id !== onlyId) continue;
    const st = states[post.id] || {};
    if (st.status === 'done') continue;
    if (st.status === 'held' && !force) continue;
    if (st.status === 'failed' && !force) continue;
    if (!force && !isDue(post)) continue;
    if (st.status === 'publishing' && Date.now() - (st.lockAt || 0) < 10 * 60 * 1000) continue;
    if (handled >= limit) break;
    handled++;
    await setState(post.id, { ...st, status: 'publishing', lockAt: Date.now() });
    try {
      const r = post.channel === 'threads' ? await publishThreadsText(post.account, post.body)
        : post.channel === 'card' ? await publishCard(post)
        : await publishReel(post, st);
      if (r.done) {
        await setState(post.id, { status: 'done', url: r.url, postId: r.postId, publishedAt: kstStamp(), attempts: (st.attempts || 0) + 1 });
        results.push({ id: post.id, status: 'done', url: r.url });
      } else {
        await setState(post.id, { ...st, status: 'processing', container: r.container, containerAt: r.containerAt, lockAt: 0 });
        results.push({ id: post.id, status: 'processing' });
      }
    } catch (e) {
      const attempts = (st.attempts || 0) + 1;
      const status = attempts >= MAX_ATTEMPTS ? 'failed' : 'retry';
      await setState(post.id, { status, error: e.message, attempts, lockAt: 0 });
      results.push({ id: post.id, status, error: e.message });
    }
  }
  return { results, problems };
}
export function accountsInUse() {
  const s = new Set(['main']);
  for (const k of Object.keys(process.env)) {
    const m = k.match(/^THREADS_TOKEN_([A-Z0-9_]+)$/);
    if (m) s.add(m[1].toLowerCase());
  }
  return [...s].filter((a) => envFor('THREADS_TOKEN', a));
}
export async function checkAccounts() {
  const accounts = new Set(['main']);
  for (const k of Object.keys(process.env)) {
    const m = k.match(/^(?:IG_TOKEN|THREADS_TOKEN)_([A-Z0-9_]+)$/);
    if (m) accounts.add(m[1].toLowerCase());
  }
  const out = [];
  for (const a of accounts) {
    const row = { account: a };
    if (envFor('IG_TOKEN', a)) {
      try {
        const t = igTarget(a);
        const u = await call('GET', `${t.base}/${t.userId}`, { fields: 'username', access_token: t.token }, 'IG_CHECK');
        row.instagram = `@${u.username}`;
      } catch (e) { row.instagramError = e.message; }
    }
    if (envFor('THREADS_TOKEN', a)) {
      try {
        const u = await call('GET', `${TH}/v1.0/me`, { fields: 'username', access_token: await threadsToken(a) }, 'THREADS_CHECK');
        row.threads = `@${u.username}`;
      } catch (e) { row.threadsError = e.message; }
    }
    if (row.instagram || row.threads || row.instagramError || row.threadsError) out.push(row);
  }
  return out;
}
export async function exchangeThreadsToken(shortToken) {
  const secret = (process.env.THREADS_APP_SECRET || '').trim();
  if (!secret) throw new Error('[THREADS_APP_SECRET] 단기 토큰을 바꾸려면 Vercel에 THREADS_APP_SECRET(앱 시크릿)이 필요해요');
  const r = await call('GET', `${TH}/access_token`, { grant_type: 'th_exchange_token', client_secret: secret, access_token: shortToken }, 'THREADS_EXCHANGE');
  return { token: r.access_token, days: Math.round((r.expires_in || 0) / 86400) };
}
