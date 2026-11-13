// 예약 시각이 지난 글을 발행한다. GitHub Actions(30분마다)와 Vercel 크론(하루 1번)이 부른다.
import { accountsInUse, refreshThreads, runDue, safeEqual } from '../lib/kit.js';

export default async function handler(req, res) {
  const auth = String(req.headers.authorization || '');
  if (!safeEqual(auth, `Bearer ${process.env.CRON_SECRET || ''}`) || !process.env.CRON_SECRET) {
    return res.status(401).json({ ok: false, error: 'CRON_SECRET이 맞지 않아요' });
  }
  try {
    const run = await runDue();
    const tokens = [];
    for (const a of accountsInUse()) tokens.push(await refreshThreads(a));
    res.status(200).json({ ok: true, ...run, tokens });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
}
