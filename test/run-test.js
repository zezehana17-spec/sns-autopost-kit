// 로컬 테스트: 메타·스레드·Upstash를 흉내 내는 가짜 서버로 발행 흐름 전체를 돌려 본다.
// 실행: npm test   (실제 계정에는 아무것도 올리지 않음)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const store = new Map();
const calls = [];
let reelChecks = 0;
const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const url = new URL(req.url, 'http://x');
  const params = Object.fromEntries(new URLSearchParams(req.method === 'POST' && !url.pathname.endsWith('/pipeline') ? body : url.search));
  calls.push({ method: req.method, path: url.pathname, params });
  const send = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/redis/pipeline') {
    return send(JSON.parse(body).map(([cmd, ...a]) => {
      if (cmd === 'SET') { store.set(a[0], a[1]); return { result: 'OK' }; }
      if (cmd === 'GET') return { result: store.get(a[0]) ?? null };
      if (cmd === 'MGET') return { result: a.map((k) => store.get(k) ?? null) };
      return { error: 'unknown' };
    }));
  }
  if (params.access_token === 'BAD') return send({ error: { message: 'Invalid OAuth access token' } }, 400);
  // 인스타(graph.facebook.com 흉내)
  if (url.pathname.startsWith('/fb/')) {
    const p = url.pathname.replace(/^\/fb\/v[\d.]+/, '');
    if (p === '/1784/media' && req.method === 'POST') return send({ id: params.media_type === 'REELS' ? 'REEL1' : params.media_type === 'CAROUSEL' ? 'CAR1' : `ITEM${calls.length}` });
    if (p === '/1784/media_publish') return send({ id: `MEDIA_${params.creation_id}` });
    if (p === '/REEL1') return send({ status_code: ++reelChecks >= 1 ? 'FINISHED' : 'IN_PROGRESS' });
    if (/^\/(CAR1|ITEM\d+)$/.test(p)) return send({ status_code: 'FINISHED' });
    if (p.startsWith('/MEDIA_')) return send({ permalink: `https://instagram.com/p/${p.slice(7)}` });
    if (p === '/1784') return send({ username: 'cafe.test' });
  }
  // 스레드
  if (url.pathname.startsWith('/th/')) {
    const p = url.pathname.replace(/^\/th/, '');
    if (p === '/v1.0/me/threads') return send({ id: `C${calls.length}` });
    if (p === '/v1.0/me/threads_publish') return send({ id: `T${calls.length}` });
    if (p === '/v1.0/me') return send({ username: 'threads.test' });
    if (p.startsWith('/v1.0/T')) return send({ permalink: `https://threads.net/t/${p.slice(6)}` });
    if (p === '/refresh_access_token') return send({ access_token: 'TH_NEW', expires_in: 5184000 });
  }
  send({ error: { message: `mock: ${req.method} ${url.pathname}` } }, 404);
});
await new Promise((r) => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

Object.assign(process.env, {
  KIT_FB_BASE: `${base}/fb`, KIT_IG_BASE: `${base}/ig`, KIT_THREADS_BASE: `${base}/th`,
  UPSTASH_REDIS_REST_URL: `${base}/redis`, UPSTASH_REDIS_REST_TOKEN: 'x',
  IG_TOKEN: 'EAAtest', IG_USER_ID: '1784', THREADS_TOKEN: 'TH_OLD',
  IG_TOKEN_BROKEN: 'BAD', IG_USER_ID_BROKEN: '1784',
  CRON_SECRET: 'secret123', ADMIN_CODE: 'admin1', SITE_URL: 'https://kit.example.com',
});

// 임시 작업 폴더에 outbox 만들기
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kit-'));
fs.mkdirSync(path.join(dir, 'outbox'));
const w = (name, o) => fs.writeFileSync(path.join(dir, 'outbox', name), JSON.stringify(o));
w('a.json', { id: 't1', channel: 'threads', publishAt: '2020-01-01 09:00', body: `첫 문단입니다.\n\n${'긴 문단 '.repeat(150)}` });
w('b.json', { id: 'c1', channel: 'card', publishAt: '2020-01-01 10:00', caption: '카드', images: ['/media/x/card01.jpg', '/media/x/card02.jpg'] });
w('c.json', { id: 'r1', channel: 'reel', publishAt: '2020-01-01 11:00', caption: '릴스', video: '/media/x/reel.mp4' });
w('d.json', { id: 'future1', channel: 'threads', publishAt: '2099-01-01 09:00', body: '미래 글' });
w('e.json', { id: 'broken1', account: 'broken', channel: 'card', publishAt: '2020-01-01 12:00', images: ['/media/x/a.jpg', '/media/x/b.jpg'] });
w('f.json', { id: 'bad id!', channel: 'threads', body: 'x' });
w('_skip.json', { id: 'skip1', channel: 'threads', body: '건너뜀' });
process.chdir(dir);

const { default: run } = await import(path.resolve(new URL('../api/run.js', import.meta.url).pathname));
const { default: admin } = await import(path.resolve(new URL('../api/admin.js', import.meta.url).pathname));
function invoke(h, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(o) { resolve({ code: this.code, body: o }); } };
    h({ method, headers, body }, res);
  });
}
const cron = () => invoke(run, { headers: { authorization: 'Bearer secret123' } });
const adm = (action, extra = {}) => invoke(admin, { body: { code: 'admin1', action, ...extra } });

// 1. 비밀값 틀리면 거절
assert.equal((await invoke(run, { headers: { authorization: 'Bearer nope' } })).code, 401);
assert.equal((await invoke(admin, { body: { code: 'x', action: 'list' } })).code, 401);

// 2. 첫 실행: 3개까지 처리 (t1 스레드, c1 카드, r1 릴스 컨테이너)
let r = await cron();
assert.equal(r.code, 200, JSON.stringify(r.body));
const byId = (x) => Object.fromEntries(x.body.results.map((y) => [y.id, y]));
let res1 = byId(r);
assert.equal(res1.t1.status, 'done');
assert.equal(res1.c1.status, 'done');
assert.equal(res1.r1.status, 'processing');
assert.equal(r.body.problems.length, 1, '잘못된 id 파일 1개');
const threadPosts = calls.filter((c) => c.path === '/th/v1.0/me/threads');
assert.ok(threadPosts.length >= 2, '긴 글은 답글로 나눠 올림');
assert.ok(threadPosts[1].params.reply_to_id, '두 번째 조각은 답글');
const cardItems = calls.filter((c) => c.path.endsWith('/1784/media') && c.params.is_carousel_item);
assert.equal(cardItems[0].params.image_url, 'https://kit.example.com/media/x/card01.jpg');

// 3. 두 번째 실행: 릴스 처리 완료 → 게시, broken 계정 실패(재시도 예정), 미래 글은 그대로
r = await cron();
let res2 = byId(r);
assert.equal(res2.r1.status, 'done');
assert.equal(res2.broken1.status, 'retry');
assert.ok(!res2.future1, '미래 글은 발행 안 함');
assert.ok(!res2.t1, '발행된 글은 다시 안 올림');

// 4. 실패 3번이면 멈춤
await cron(); r = await cron();
assert.equal(byId(r).broken1.status, 'failed');
r = await cron();
assert.ok(!byId(r).broken1, '실패 확정 글은 자동으로 다시 안 함');

// 5. 관리 화면: 목록, 멈추기, 지금 발행, 계정 확인
let l = await adm('list');
const st = Object.fromEntries(l.body.posts.map((p) => [p.id, p.state.status || '']));
assert.deepEqual([st.t1, st.c1, st.r1, st.broken1, st.future1], ['done', 'done', 'done', 'failed', '']);
assert.equal((await adm('hold', { id: 'future1' })).body.ok, true);
assert.equal((await adm('hold', { id: 't1' })).body.ok, false, '발행된 글은 멈출 수 없음');
r = await adm('publish_now', { id: 'future1' });
assert.equal(r.body.results[0].status, 'done', '멈춘 글도 지금 발행은 됨');
const chk = await adm('check');
const main = chk.body.accounts.find((a) => a.account === 'main');
assert.equal(main.instagram, '@cafe.test');
assert.equal(main.threads, '@threads.test');
assert.ok(chk.body.accounts.find((a) => a.account === 'broken').instagramError);
assert.equal((await adm('cron_setup')).body.CRON_SECRET, 'secret123');

// 6. 스레드 토큰 연장: 처음엔 기록만, 25시간 뒤엔 연장, 그다음엔 새 토큰 사용
const saved = JSON.parse(store.get('threads:main'));
store.set('threads:main', JSON.stringify({ ...saved, firstSeen: Date.now() - 26 * 3600 * 1000 }));
r = await cron();
assert.equal(r.body.tokens[0].refreshed, true);
calls.length = 0;
await adm('test_threads', { text: '테스트' });
assert.equal(calls.find((c) => c.path === '/th/v1.0/me/threads').params.access_token, 'TH_NEW');
assert.ok(!JSON.stringify([...store.values()]).includes('TH_NEW'), '저장된 토큰은 암호화됨');

server.close();
console.log('모든 테스트 통과');
