// 관리 화면용 API. 모든 요청에 ADMIN_CODE가 필요하다.
import {
  checkAccounts, exchangeThreadsToken, getStates, isDue, kstStamp, loadOutbox,
  publishThreadsText, runDue, safeEqual, setState, siteOrigin,
} from '../lib/kit.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST만 돼요' });
  const b = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  if (!process.env.ADMIN_CODE || !safeEqual(b.code, process.env.ADMIN_CODE)) {
    return res.status(401).json({ ok: false, error: '관리 코드가 맞지 않아요' });
  }
  try {
    switch (b.action) {
      case 'list': {
        const { posts, problems } = loadOutbox();
        const states = await getStates(posts.map((p) => p.id));
        return res.json({
          ok: true, now: kstStamp(), problems,
          posts: posts.map((p) => ({
            id: p.id, account: p.account, channel: p.channel, publishAt: p.publishAt || '',
            due: isDue(p), preview: String(p.body || p.caption || '').slice(0, 120),
            media: p.video ? [p.video] : (p.images || []),
            state: states[p.id] || {},
          })),
        });
      }
      case 'check':
        return res.json({ ok: true, accounts: await checkAccounts(), site: siteOrigin(), store: true });
      case 'test_threads': {
        const text = String(b.text || '').trim() || `자동 발행 연결 테스트 (${kstStamp()})`;
        return res.json({ ok: true, ...(await publishThreadsText(b.account || 'main', text)) });
      }
      case 'publish_now':
        return res.json({ ok: true, ...(await runDue({ onlyId: String(b.id || ''), force: true, limit: 1 })) });
      case 'hold':
      case 'unhold':
      case 'reset': {
        const id = String(b.id || '');
        const cur = (await getStates([id]))[id] || {};
        if (cur.status === 'done') return res.json({ ok: false, error: '이미 발행된 글이에요' });
        await setState(id, b.action === 'hold' ? { ...cur, status: 'held' } : {});
        return res.json({ ok: true });
      }
      case 'cron_setup':
        return res.json({ ok: true, SITE_URL: siteOrigin(), CRON_SECRET: process.env.CRON_SECRET || '' });
      case 'threads_long':
        return res.json({ ok: true, ...(await exchangeThreadsToken(String(b.token || '').trim())) });
      default:
        return res.status(400).json({ ok: false, error: '알 수 없는 요청' });
    }
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
}
