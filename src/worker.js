// 個人記帳 Worker：登入與 session、轉發 Notion API、提供靜態網頁
//
// Notion 使用 2025-09-03 版 API：database 是容器，實際資料掛在底下的 data source，
// 因此查詢與建立頁面都以 NOTION_DS_ID（data source ID）為準，而非 database ID。
// 取得方式見 README。
const NOTION = 'https://api.notion.com/v1';
const NOTION_VERSION = '2025-09-03';

// Gemini Interactions API（2026-06 GA，取代 generateContent 成為預設介面）
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const EXPENSE_CATS = ['食', '衣', '住', '行', '娛樂', '醫療健康', '學習進修', '人情社交', '訂閱服務', '其他'];
const INCOME_CATS = ['薪資', '獎金', '投資收益', '退款退費', '其他收入'];
const CURRENCIES = ['TWD', 'JPY', 'USD', 'EUR', 'KRW', 'CNY'];
const PAYMENTS = ['現金', '刷卡', '轉帳', '悠遊卡', '儲值卡', '行動支付'];

// ---- 本地開發用 mock 資料（.dev.vars 設 MOCK=1 時啟用，完全不碰 Notion）----
let mockSeq = 100;
let mockStore = [
  { id: 'mock-1', name: '午餐 便當', date: '2026-08-01T12:20:00+08:00', type: '支出', amount: 110, currency: 'TWD', rate: 1, twd: 110, category: '食', payment: '現金', note: '', excluded: false, creator: 'Jason' },
  { id: 'mock-2', name: 'Netflix 月費', date: '2026-08-01T09:00:00+08:00', type: '支出', amount: 390, currency: 'TWD', rate: 1, twd: 390, category: '訂閱服務', payment: '刷卡', note: '標準方案', excluded: false, creator: 'Jason' },
  { id: 'mock-3', name: '加油', date: '2026-07-28T18:40:00+08:00', type: '支出', amount: 1250, currency: 'TWD', rate: 1, twd: 1250, category: '行', payment: '刷卡', note: '', excluded: false, creator: 'Jason', km: 512, liter: 40.3 },
  { id: 'mock-4', name: '7 月薪資', date: '2026-07-05T10:00:00+08:00', type: '收入', amount: 62000, currency: 'TWD', rate: 1, twd: 62000, category: '薪資', payment: '轉帳', note: '', excluded: false, creator: 'Jason' },
  { id: 'mock-5', name: '信用卡繳費', date: '2026-07-15T10:00:00+08:00', type: '支出', amount: 18400, currency: 'TWD', rate: 1, twd: 18400, category: '其他', payment: '轉帳', note: '資金移轉，不計入統計', excluded: true, creator: 'Jason' },
  { id: 'mock-6', name: '一蘭拉麵', date: '2026-07-20T13:10:00+09:00', type: '支出', amount: 980, currency: 'JPY', rate: 0.21, twd: 205.8, category: '食', payment: '現金', note: '出差', excluded: false, creator: 'Jason' },
  { id: 'mock-7', name: '房租', date: '2026-07-01T09:00:00+08:00', type: '支出', amount: 16000, currency: 'TWD', rate: 1, twd: 16000, category: '住', payment: '轉帳', note: '', excluded: false, creator: 'Jason' },
  { id: 'mock-8', name: '電費', date: '2026-07-10T09:00:00+08:00', type: '支出', amount: 1480, currency: 'TWD', rate: 1, twd: 1480, category: '住', payment: '轉帳', note: '', excluded: false, creator: 'Jason', usage: 320 }
];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(req, env, url);
      } catch (e) {
        return json({ error: String(e.message || e) }, 500);
      }
    }
    return env.ASSETS.fetch(req);
  }
};

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  });
}

function codes(env) {
  try { return JSON.parse(env.PASSCODES || '{}'); } catch { return {}; }
}

// ---- 登入與 session ----
// 通行碼只在 /api/login 出現一次（有 IP 與名字雙重節流），之後改用 128-bit 隨機 session id，
// 放在 JavaScript 讀不到的 HttpOnly cookie。舊版每個請求都帶 x-code，
// 等於任何資料端點都能拿來無限次暴力猜通行碼，登入端點的節流形同虛設。
const COOKIE = '__Host-sid';
const SESSION_DAYS = 180;

function sameCode(a, b) {
  const ea = new TextEncoder().encode(String(a)), eb = new TextEncoder().encode(String(b));
  return ea.length === eb.length && crypto.subtle.timingSafeEqual(ea, eb);
}

async function sha16(s) {
  const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(h)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

function getCookie(req, name) {
  for (const part of (req.headers.get('cookie') || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

const sessionCookie = (sid, maxAge) => `${COOKIE}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

async function hits(env, key) { return Number(await env.CACHE.get(key)) || 0; }
async function bump(env, key, ttl) { await env.CACHE.put(key, String(await hits(env, key) + 1), { expirationTtl: ttl }); }

// session 記下登入當時通行碼的指紋：改掉某人的通行碼（或把他從 PASSCODES 拿掉），他所有裝置立刻失效
async function currentUser(req, env) {
  const sid = getCookie(req, COOKIE);
  if (!sid || !/^[\w-]{16,64}$/.test(sid)) return null;
  const s = await env.CACHE.get(`sess:${sid}`, 'json');
  if (!s) return null;
  const code = codes(env)[s.user];
  if (code == null || s.pv !== await sha16(`${s.user} ${code}`)) {
    await env.CACHE.delete(`sess:${sid}`);
    return null;
  }
  return s.user;
}

// ---- 月份工具（一律以台北時間為準）----
const TZ_OFFSET = '+08:00';

function monthOf(iso) {
  return String(iso || '').slice(0, 7); // 'YYYY-MM'
}

function monthBounds(month) {
  const [y, m] = month.split('-').map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return { start: `${month}-01`, endExclusive: `${next}-01` };
}

function shiftMonth(month, delta) {
  const [y, m] = month.split('-').map(Number);
  const t = (y * 12 + (m - 1)) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

function currentMonth() {
  // Worker 跑在 UTC，換算成台北時間再取月份
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 7);
}

// ---- KV 快取 ----
// 當月資料常變動，給短 TTL（即使你直接在 Notion 改東西，最多 5 分鐘就會同步）；
// 過去的月份幾乎不動，給長 TTL。任何經由本 API 的寫入都會即時清掉相關快取。
function cacheTtl(month) {
  return month === currentMonth() ? 300 : 2592000;
}

async function cacheGet(env, key) {
  if (!env.CACHE) return null;
  try { return await env.CACHE.get(key, 'json'); } catch { return null; }
}

async function cachePut(env, key, value, ttl) {
  if (!env.CACHE) return;
  try { await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl }); } catch { /* 快取失敗不影響功能 */ }
}

async function cacheDrop(env, keys) {
  if (!env.CACHE) return;
  await Promise.all([...new Set(keys)].map(k => env.CACHE.delete(k).catch(() => {})));
}

// 寫入後讓受影響的月份與所有彙總失效
async function invalidate(env, months) {
  const keys = months.filter(Boolean).map(m => `m:${m}`);
  keys.push('sum:12', 'sum:6');
  await cacheDrop(env, keys);
}

async function handleApi(req, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = req.method;
  const mock = env.MOCK === '1';

  // 會改變狀態的請求必須來自本站（SameSite=Lax 之外再加一道）
  if (method !== 'GET') {
    const origin = req.headers.get('origin');
    if (origin && origin !== url.origin) return json({ error: '來源不符' }, 403);
  }

  // ---- 登入：唯一不需要 session 的端點。同一 IP 一小時錯 10 次、同一名字一小時錯 20 次就暫停 ----
  if (path === '/api/login' && method === 'POST') {
    const body = await req.json().catch(() => ({}));
    const user = String(body.user || ''), code = String(body.code || '');
    const ipKey = `rl:ip:${req.headers.get('cf-connecting-ip') || 'local'}`, userKey = `rl:user:${user}`;
    if (await hits(env, ipKey) >= 10 || await hits(env, userKey) >= 20) {
      return json({ error: '嘗試次數太多，請一小時後再試' }, 429);
    }
    const all = codes(env);
    if (!Object.hasOwn(all, user) || !code || !sameCode(all[user], code)) {
      await Promise.all([bump(env, ipKey, 3600), bump(env, userKey, 3600)]);
      return json({ error: '名字或通行碼不正確' }, 401);
    }
    await Promise.all([env.CACHE.delete(ipKey), env.CACHE.delete(userKey)]);
    const sid = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const expiration = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
    await env.CACHE.put(`sess:${sid}`, JSON.stringify({ user, pv: await sha16(`${user} ${code}`) }), { expiration });
    return json({ ok: true, user }, 200, { 'set-cookie': sessionCookie(sid, SESSION_DAYS * 86400) });
  }

  if (path === '/api/logout' && method === 'POST') {
    const sid = getCookie(req, COOKIE);
    if (sid && /^[\w-]{16,64}$/.test(sid)) await env.CACHE.delete(`sess:${sid}`);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  const me = await currentUser(req, env);
  if (!me) return json({ error: 'unauthorized' }, 401, { 'set-cookie': sessionCookie('', 0) });

  if (path === '/api/me' && method === 'GET') return json({ user: me });

  // ---- 讀取某個月的記錄 ----
  if (path === '/api/expenses' && method === 'GET') {
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get('month') || '')
      ? url.searchParams.get('month')
      : currentMonth();
    const fresh = url.searchParams.get('fresh') === '1';
    const key = `m:${month}`;

    if (!fresh) {
      const hit = await cacheGet(env, key);
      if (hit) return json({ month, expenses: hit, cached: true });
    }

    let expenses;
    if (mock) {
      expenses = mockStore.filter(x => monthOf(x.date) === month)
        .sort((a, b) => (a.date < b.date ? 1 : -1));
    } else {
      expenses = await queryMonth(env, month);
    }
    await cachePut(env, key, expenses, cacheTtl(month));
    return json({ month, expenses, cached: false });
  }

  // ---- 月度彙總（統計頁的趨勢圖）----
  if (path === '/api/summary' && method === 'GET') {
    const n = Math.min(Math.max(Number(url.searchParams.get('months')) || 12, 1), 24);
    const key = `sum:${n}`;
    const fresh = url.searchParams.get('fresh') === '1';

    if (!fresh) {
      const hit = await cacheGet(env, key);
      if (hit) return json({ months: hit, cached: true });
    }

    const cur = currentMonth();
    const from = shiftMonth(cur, -(n - 1));
    const rows = mock
      ? mockStore.filter(x => monthOf(x.date) >= from)
      : await queryRange(env, `${from}-01`, monthBounds(cur).endExclusive);

    // 預先鋪滿每個月，沒有資料的月份也要有 0，折線圖才不會斷掉
    const buckets = {};
    for (let i = 0; i < n; i++) buckets[shiftMonth(from, i)] = { month: shiftMonth(from, i), income: 0, expense: 0 };
    for (const r of rows) {
      if (r.excluded) continue; // 資金移轉不計入
      const b = buckets[monthOf(r.date)];
      if (!b) continue;
      if (r.type === '收入') b.income += r.twd || 0;
      else b.expense += r.twd || 0;
    }
    const months = Object.values(buckets).map(b => ({
      month: b.month,
      income: Math.round(b.income),
      expense: Math.round(b.expense)
    }));
    await cachePut(env, key, months, 300);
    return json({ months, cached: false });
  }

  // ---- 新增一筆（記錄者一律以登入身分為準，不接受前端指定）----
  if (path === '/api/expenses' && method === 'POST') {
    const e = normalize(await req.json());
    e.creator = me;

    let created;
    if (mock) {
      created = { ...e, id: 'mock-' + (mockSeq++), twd: round2(e.amount * e.rate) };
      mockStore.unshift(created);
    } else {
      const r = await notion(env, '/pages', 'POST', {
        parent: { type: 'data_source_id', data_source_id: env.NOTION_DS_ID },
        properties: toProps(e)
      });
      created = toExpense(r);
    }
    await invalidate(env, [monthOf(created.date)]);
    return json({ expense: created });
  }

  // ---- 修改 / 刪除單筆 ----
  const m = path.match(/^\/api\/expenses\/([\w-]+)$/);
  if (m && (method === 'PATCH' || method === 'DELETE')) {
    const id = m[1];

    if (mock) {
      const i = mockStore.findIndex(x => x.id === id);
      if (i < 0) return json({ error: 'not found' }, 404);
      const oldMonth = monthOf(mockStore[i].date);
      if (method === 'DELETE') {
        mockStore.splice(i, 1);
        await invalidate(env, [oldMonth]);
        return json({ ok: true });
      }
      const patch = normalize(await req.json(), true);
      mockStore[i] = { ...mockStore[i], ...patch };
      mockStore[i].twd = round2(mockStore[i].amount * mockStore[i].rate);
      await invalidate(env, [oldMonth, monthOf(mockStore[i].date)]);
      return json({ expense: mockStore[i] });
    }

    // 先讀回原記錄，才知道要讓「哪一個月」的快取失效（編輯有可能改到日期）。
    // 多一次 API 呼叫，但編輯是低頻操作，換來快取永遠不會殘留舊值。
    const before = await notion(env, `/pages/${id}`, 'GET');
    const oldMonth = monthOf(toExpense(before).date);

    if (method === 'DELETE') {
      await notion(env, `/pages/${id}`, 'PATCH', { in_trash: true });
      await invalidate(env, [oldMonth]);
      return json({ ok: true });
    }

    const patch = normalize(await req.json(), true);
    const r = await notion(env, `/pages/${id}`, 'PATCH', { properties: toProps(patch) });
    const updated = toExpense(r);
    await invalidate(env, [oldMonth, monthOf(updated.date)]);
    return json({ expense: updated });
  }

  // ---- 收據辨識 ----
  // 前端傳壓縮後的 JPEG base64，交給 Gemini 視覺模型抽出結構化欄位。
  // 照片只在這條請求裡經過，不儲存於任何地方。
  if (path === '/api/scan' && method === 'POST') {
    return handleScan(req, env, mock);
  }

  return json({ error: 'not found' }, 404);
}

// ---- Notion 查詢 ----
async function queryMonth(env, month) {
  const { start, endExclusive } = monthBounds(month);
  return queryRange(env, start, endExclusive);
}

async function queryRange(env, start, endExclusive) {
  const all = [];
  let cursor = null;
  do {
    const body = {
      page_size: 100,
      filter: {
        and: [
          { property: '日期', date: { on_or_after: start } },
          { property: '日期', date: { before: endExclusive } }
        ]
      },
      sorts: [{ property: '日期', direction: 'descending' }]
    };
    if (cursor) body.start_cursor = cursor;
    const r = await notion(env, `/data_sources/${env.NOTION_DS_ID}/query`, 'POST', body);
    all.push(...r.results.map(toExpense));
    cursor = r.has_more ? r.next_cursor : null;
  } while (cursor);
  return all;
}

async function notion(env, path, method, body) {
  if (!env.NOTION_TOKEN) throw new Error('NOTION_TOKEN 尚未設定（wrangler secret put NOTION_TOKEN）');
  if (!env.NOTION_DS_ID) throw new Error('NOTION_DS_ID 尚未設定（wrangler secret put NOTION_DS_ID）');
  const r = await fetch(NOTION + path, {
    method,
    headers: {
      'authorization': `Bearer ${env.NOTION_TOKEN}`,
      'notion-version': NOTION_VERSION,
      'content-type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Notion API ${r.status}: ${t.slice(0, 300)}`);
  }
  return r.json();
}

// ---- 欄位轉換 ----
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// 收斂前端傳來的資料：補預設值、擋掉不在白名單內的選項值。
// partial=true 時只處理有提供的欄位，供 PATCH 做部分更新。
function normalize(e, partial = false) {
  const o = {};
  const has = k => e[k] !== undefined && e[k] !== null;

  if (has('name') || !partial) o.name = String(e.name || '').slice(0, 200);
  if (has('date') || !partial) o.date = e.date || new Date().toISOString();
  if (has('type') || !partial) o.type = e.type === '收入' ? '收入' : '支出';
  if (has('amount') || !partial) o.amount = Math.abs(Number(e.amount) || 0);
  if (has('currency') || !partial) o.currency = CURRENCIES.includes(e.currency) ? e.currency : 'TWD';
  if (has('rate') || !partial) o.rate = Number(e.rate) > 0 ? Number(e.rate) : 1;
  if (has('category') || !partial) {
    const valid = [...EXPENSE_CATS, ...INCOME_CATS];
    o.category = valid.includes(e.category) ? e.category : (o.type === '收入' ? '其他收入' : '其他');
  }
  if (has('payment')) o.payment = PAYMENTS.includes(e.payment) ? e.payment : '現金';
  else if (!partial) o.payment = '現金';
  if (has('note') || !partial) o.note = String(e.note || '').slice(0, 1900);
  if (has('excluded') || !partial) o.excluded = !!e.excluded;
  for (const k of ['km', 'liter', 'usage']) {
    if (has(k)) o[k] = Number(e[k]) || 0;
  }
  return o;
}

function toExpense(p) {
  const pr = p.properties || {};
  const text = k => (pr[k]?.rich_text || []).map(t => t.plain_text).join('');
  return {
    id: p.id,
    name: (pr['名稱']?.title || []).map(t => t.plain_text).join(''),
    date: pr['日期']?.date?.start || p.created_time,
    type: pr['類型']?.select?.name || '支出',
    amount: pr['金額']?.number ?? 0,
    currency: pr['幣別']?.select?.name || 'TWD',
    rate: pr['匯率']?.number ?? 1,
    twd: pr['台幣金額']?.formula?.number ?? round2((pr['金額']?.number ?? 0) * (pr['匯率']?.number ?? 1)),
    category: pr['類別']?.select?.name || '其他',
    payment: pr['付款方式']?.select?.name || '',
    note: text('備註'),
    excluded: pr['不計入統計']?.checkbox || false,
    creator: pr['記錄者']?.select?.name || '',
    km: pr['公里數']?.number ?? null,
    liter: pr['公升數']?.number ?? null,
    usage: pr['用量']?.number ?? null
  };
}

// 只轉換有提供的欄位，讓 PATCH 可以做部分更新
function toProps(e) {
  const pr = {};
  if (e.name !== undefined) pr['名稱'] = { title: [{ text: { content: e.name || '' } }] };
  if (e.date !== undefined) pr['日期'] = { date: { start: e.date } };
  if (e.type !== undefined) pr['類型'] = { select: { name: e.type } };
  if (e.amount !== undefined) pr['金額'] = { number: Number(e.amount) };
  if (e.currency !== undefined) pr['幣別'] = { select: { name: e.currency } };
  if (e.rate !== undefined) pr['匯率'] = { number: Number(e.rate) };
  if (e.category !== undefined) pr['類別'] = { select: { name: e.category } };
  if (e.payment !== undefined) pr['付款方式'] = e.payment ? { select: { name: e.payment } } : { select: null };
  if (e.note !== undefined) pr['備註'] = { rich_text: e.note ? [{ text: { content: e.note } }] : [] };
  if (e.excluded !== undefined) pr['不計入統計'] = { checkbox: !!e.excluded };
  if (e.creator) pr['記錄者'] = { select: { name: e.creator } };
  for (const [k, prop] of [['km', '公里數'], ['liter', '公升數'], ['usage', '用量']]) {
    if (e[k] !== undefined) pr[prop] = { number: e[k] === null || e[k] === '' ? null : Number(e[k]) };
  }
  return pr;
}

// ---- 收據辨識 ----
async function handleScan(req, env, mock) {
  const { image, mime } = await req.json();
  if (!image) return json({ error: 'no image' }, 400);

  if (mock) {
    return json({
      ok: true,
      data: { amount: 268, currency: 'TWD', name: '全家便利商店｜咖啡、御飯糰', category: '食', payment: '刷卡', date: '2026-08-01', time: '12:34' }
    });
  }
  if (!env.GEMINI_API_KEY) {
    return json({ error: 'GEMINI_API_KEY 尚未設定（wrangler secret put GEMINI_API_KEY）' }, 500);
  }

  const prompt = `你是個人記帳助手。這張圖片是一張消費憑證，可能是任何國家的收據、發票、帳單、票券、訂單確認畫面，或信用卡簽帳單。請抽取資訊，只輸出 JSON：
- is_receipt：圖片若不是消費憑證（風景、人物、菜單看板等），設 false，其他欄位隨意。
  注意：信用卡簽帳單（有商店代號、端末機代號、卡號、授權碼 APP.CODE、銷售 SALE 等欄位）也算消費憑證，設 true
- amount：實際支付的總金額。優先取「合計／總計／AMT／Total／税込」；絕對不要取小計、應付現金、找零、預付金額
- currency：依憑證判斷幣別。NT$／新台幣為 TWD；日圓 JPY；美元 USD；歐元 EUR；韓元 KRW；人民幣 CNY。判斷不出來時給 TWD
- name：格式「店名｜品項摘要」。店名保留原文；品項摘要列出主要品項最多 3 項，更多加「等」，例如「全家便利商店｜咖啡、御飯糰等」。
  水電瓦斯帳單寫「台電｜7月電費」這種形式。信用卡簽帳單通常只有店名沒有品項，那就只寫店名
- category：只能從這幾個選一：${EXPENSE_CATS.join('、')}。便利商店買食物飲料算「食」；車票、加油、停車、計程車算「行」；水電瓦斯、房租、家用品算「住」；藥局、藥妝店、診所、醫院算「醫療健康」；電影、遊戲、展覽算「娛樂」
- payment：付款方式，只能從這幾個選一：${PAYMENTS.join('、')}，真的看不出來才給「未知」。判斷依據：
  出現 VISA／MasterCard／JCB／銀聯／卡號 CARD NO.／授權碼 APP.CODE／端末機代號／簽帳單／SALE 銷售 → 刷卡
  出現 現金／CASH／找零／CHANGE／お預り → 現金
  出現 LINE Pay／街口／悠遊付／Apple Pay／Google Pay／掃碼支付 → 行動支付
  出現 悠遊卡／一卡通／icash 感應扣款 → 悠遊卡
  出現 禮物卡／儲值卡／餘額扣款 → 儲值卡
  出現 轉帳／匯款／ATM → 轉帳
- date：憑證上的消費日期，格式 YYYY-MM-DD，讀不到就 null
- time：憑證上的消費時間，24 小時制 HH:MM（下午 2:05 寫 14:05），讀不到就 null。只印日期沒印時間也給 null，不要自己編一個`;

  // 結構化輸出：用 response_format 的 json_schema 鎖死欄位與型別，
  // 模型不可能回出多餘字句或缺欄位，不必只靠提示詞約束格式
  const schema = {
    type: 'object',
    properties: {
      is_receipt: { type: 'boolean' },
      amount: { type: 'number' },
      currency: { type: 'string', enum: CURRENCIES },
      name: { type: 'string' },
      category: { type: 'string', enum: EXPENSE_CATS },
      // 「未知」是刻意留的出口：與其讓模型硬猜一個付款方式，不如回未知、
      // 前端保留使用者原本的選擇，不要拿錯的值覆蓋掉
      payment: { type: 'string', enum: [...PAYMENTS, '未知'] },
      date: { type: ['string', 'null'] },
      time: { type: ['string', 'null'] }
    },
    required: ['is_receipt', 'amount', 'currency', 'name', 'category', 'payment']
  };

  const call = (model) => fetch(GEMINI, {
    method: 'POST',
    // AI Studio 的 API key 要走 x-goog-api-key。用 Authorization: Bearer 會被當成 OAuth token
    // 而回 401「Expected OAuth 2 access token」——實測踩過，別改回去。
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      input: [
        { type: 'text', text: prompt },
        { type: 'image', data: image, mime_type: mime || 'image/jpeg' }
      ],
      // 結構化輸出的正確形狀（見 ai.google.dev/gemini-api/docs/structured-output）：
      // type 是 'text'、mime_type 指定 application/json、schema 放 JSON Schema。
      // 不是 OpenAI 那種 {type:'json_schema', json_schema:{...}} 的包裝。
      response_format: { type: 'text', mime_type: 'application/json', schema }
    })
  });

  // 模型鏈依序嘗試：429（額度滿）/ 503（服務過載）/ 404（模型退役）都換下一個模型重打
  const models = (env.GEMINI_MODELS || 'gemini-3.6-flash,gemini-3.5-flash,gemini-3.5-flash-lite')
    .split(',').map(s => s.trim()).filter(Boolean);
  let gr = null;
  for (const model of models) {
    gr = await call(model);
    if (gr.ok || ![429, 503, 404].includes(gr.status)) break;
  }
  if (!gr.ok) {
    const t = await gr.text();
    if (gr.status === 429) return json({ error: '辨識額度暫時用完，請稍後再試或先手動輸入' }, 429);
    if (gr.status === 503) return json({ error: '辨識服務暫時忙碌，請過幾秒再試一次' }, 503);
    return json({ error: `Gemini ${gr.status}: ${t.slice(0, 200)}` }, 502);
  }

  let d;
  try { d = JSON.parse(extractText(await gr.json())); } catch { return json({ ok: false, error: 'unrecognized' }); }
  if (!d || d.is_receipt === false || !(Number(d.amount) > 0)) return json({ ok: false, error: 'unrecognized' });

  // 模型偶爾會回 9:05 或 14:05:33，收斂成 <input type="time"> 吃的 HH:MM；不合理的時刻一律當讀不到
  const tm = /^(\d{1,2}):(\d{2})/.exec(d.time || '');
  const time = tm && Number(tm[1]) < 24 && Number(tm[2]) < 60 ? `${tm[1].padStart(2, '0')}:${tm[2]}` : null;

  return json({
    ok: true,
    data: {
      amount: Number(d.amount),
      currency: CURRENCIES.includes(d.currency) ? d.currency : 'TWD',
      name: String(d.name || '').slice(0, 80),
      category: EXPENSE_CATS.includes(d.category) ? d.category : '其他',
      payment: PAYMENTS.includes(d.payment) ? d.payment : null, // null＝辨識不出，前端不覆蓋
      date: /^\d{4}-\d{2}-\d{2}$/.test(d.date || '') ? d.date : null,
      time // null＝讀不到，前端保留欄位原本的時間
    }
  });
}

// Interactions API 把模型輸出放在 steps[].content[].text。
// 這裡走訪整個結構收集文字，順帶相容舊的 candidates 形狀，之後 API 微調也不會直接壞掉。
function extractText(res) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node.text === 'string') out.push(node.text);
    for (const k of ['steps', 'content', 'parts', 'candidates', 'output', 'message']) {
      if (node[k]) walk(node[k]);
    }
  };
  walk(res);
  return out.join('').trim();
}
