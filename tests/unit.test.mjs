// tests/unit.test.mjs — çalıştırma:  npm install && npm test
import test from 'node:test';
import assert from 'node:assert/strict';
// fake-indexeddb yalnızca IndexedDB testi içindir; kurulu değilse o test atlanır.
let HAS_IDB = true;
try {
  await import('fake-indexeddb/auto');
} catch {
  HAS_IDB = false;
}

import { dedupe, iou, ownedByTile, planTiles, tileToGlobal } from '../shared/geometry.js';
import { buildMatchPatterns, findSite, hostMatches, isUrlAllowed, normalizeHost } from '../shared/sites.js';
import { cleanHex, extractItems, normalizeItem, salvageObjects } from '../shared/items.js';
import { AppError, ERR } from '../shared/errors.js';
import { buildPrompt } from '../background/prompts.js';
import { buildGeminiRequest, classifyGeminiError, parseGeminiResponse } from '../background/providers/gemini.js';
import { parseOllamaResponse } from '../background/providers/ollama.js';
import { DEFAULTS, deepMerge, publicSettings } from '../shared/settings.js';

// ---------------------------------------------------------------- chrome.storage taklidi
const store = {};
globalThis.chrome = {
  storage: {
    local: {
      async get(k) {
        return k in store ? { [k]: structuredClone(store[k]) } : {};
      },
      async set(o) {
        Object.assign(store, structuredClone(o));
      },
    },
  },
  runtime: { getPlatformInfo: async () => ({}) },
};

// ================================================================ geometri
test('planTiles: tipik 800x1280 dilim tek parça olur', () => {
  const t = planTiles(800, 1280);
  assert.equal(t.length, 1);
  assert.deepEqual([t[0].y0, t[0].y1], [0, 1280]);
});

test('planTiles: uzun görsel örtüşen parçalara bölünür, sahiplik aralıkları kesintisiz', () => {
  const h = 9000;
  const tiles = planTiles(800, h);
  assert.ok(tiles.length > 1);
  assert.equal(tiles[0].y0, 0);
  assert.equal(tiles.at(-1).y1, h);
  for (let i = 0; i < tiles.length - 1; i++) {
    assert.ok(tiles[i + 1].y0 < tiles[i].y1, 'parçalar örtüşmeli');
    assert.equal(tiles[i].own1, tiles[i + 1].own0, 'sahiplik aralığı boşluksuz/çakışmasız');
  }
  for (const t of tiles) assert.ok(t.y1 - t.y0 <= 800 * 2.0 + 1);
});

test('her piksel tam olarak bir parçaya aittir', () => {
  const h = 7777;
  const tiles = planTiles(720, h);
  for (let y = 0; y < h; y += 13) {
    const owners = tiles.filter((t) => y >= t.own0 && y < t.own1);
    assert.equal(owners.length, 1, `y=${y}`);
  }
});

test('tileToGlobal + ownedByTile', () => {
  const tiles = planTiles(800, 6000);
  const t = tiles[1];
  const g = tileToGlobal([0.1, 0.5, 0.3, 0.6], t, 6000);
  assert.ok(g[1] > t.y0 / 6000 && g[1] < t.y1 / 6000);
  assert.equal(typeof ownedByTile(g, t, 6000), 'boolean');
});

test('iou / dedupe', () => {
  const a = { box: [0.1, 0.1, 0.3, 0.2] };
  const b = { box: [0.11, 0.1, 0.31, 0.2] };
  const c = { box: [0.6, 0.6, 0.8, 0.7] };
  assert.ok(iou(a.box, b.box) > 0.8);
  assert.equal(iou(a.box, c.box), 0);
  assert.equal(dedupe([a, b, c]).length, 2);
});

// ================================================================ siteler
test('normalizeHost', () => {
  assert.equal(normalizeHost('https://www.WebToons.com/en/x?y=1'), 'webtoons.com');
  assert.equal(normalizeHost('webtoons.com'), 'webtoons.com');
  assert.equal(normalizeHost('asura.gg/series'), 'asura.gg');
  assert.equal(normalizeHost('abc'), null);
  assert.equal(normalizeHost(''), null);
});

test('hostMatches / isUrlAllowed / buildMatchPatterns', () => {
  assert.ok(hostMatches('m.webtoons.com', 'webtoons.com'));
  assert.ok(hostMatches('www.webtoons.com', 'webtoons.com'));
  assert.ok(!hostMatches('evilwebtoons.com', 'webtoons.com'));
  const s = { enabled: true, sites: [{ host: 'webtoons.com', enabled: true }, { host: 'x.com', enabled: false }] };
  assert.ok(isUrlAllowed('https://www.webtoons.com/en/a', s));
  assert.ok(!isUrlAllowed('https://x.com/a', s));
  assert.ok(!isUrlAllowed('https://other.com/', s));
  assert.ok(!isUrlAllowed('chrome://settings', s));
  assert.ok(!isUrlAllowed('https://www.webtoons.com/', { ...s, enabled: false }));
  assert.deepEqual(buildMatchPatterns(s.sites), ['*://*.webtoons.com/*']);
  assert.equal(findSite(s.sites, 'https://sub.webtoons.com/').host, 'webtoons.com');
  assert.deepEqual(buildMatchPatterns([{ host: '127.0.0.1', enabled: true }, { host: 'localhost', enabled: true }]), ['*://127.0.0.1/*', '*://localhost/*']);
});

// ================================================================ JSON / öğeler
test('extractItems: düz, çitli ve kesik JSON', () => {
  const ok = '{"texts":[{"box_2d":[0,0,10,10],"original":"Hi","translation":"Selam"}]}';
  assert.equal(extractItems(ok).length, 1);
  assert.equal(extractItems('```json\n' + ok + '\n```').length, 1);
  assert.equal(extractItems('').length, 0);
  assert.equal(extractItems('{"texts":[]}').length, 0);
  const truncated =
    '{"texts":[{"box_2d":[1,2,3,4],"original":"A","translation":"B"},{"box_2d":[5,6,7,8],"original":"C","transl';
  const got = extractItems(truncated);
  assert.equal(got.length, 1);
  assert.equal(got[0].translation, 'B');
  assert.equal(extractItems('tamamen saçma'), null);
  assert.equal(salvageObjects('[{"a":"}"},{"b":1}]').length, 2);
});

test('normalizeItem: Gemini yxyx ve Qwen xyxy dönüşümü', () => {
  const g = normalizeItem(
    { box_2d: [100, 200, 300, 600], original: 'Hi', translation: 'Selam', kind: 'speech', bg: '#FFF', fg: 'black' },
    { order: 'yxyx' },
  );
  assert.deepEqual(g.box, [0.2, 0.1, 0.6, 0.3]);
  assert.equal(g.bg, '#ffffff');
  assert.equal(g.fg, '#000000');

  const q = normalizeItem({ bbox_2d: [200, 100, 600, 300], translation: 'x' }, { order: 'xyxy' });
  assert.deepEqual(q.box, [0.2, 0.1, 0.6, 0.3]);

  const abs = normalizeItem({ box_2d: [100, 50, 300, 150], translation: 'x' }, { order: 'xyxy', w: 1000, h: 500 });
  assert.deepEqual(abs.box, [0.1, 0.1, 0.3, 0.3]);
});

test('normalizeItem: geçersizleri eler', () => {
  assert.equal(normalizeItem({ box_2d: [1, 2, 3], translation: 'x' }), null);
  assert.equal(normalizeItem({ box_2d: [0, 0, 100, 100] }), null);
  assert.equal(normalizeItem({ box_2d: [10, 10, 10, 10], translation: 'x' }), null);
  assert.equal(normalizeItem({ box_2d: ['a', 0, 5, 5], translation: 'x' }), null);
  assert.equal(normalizeItem(null), null);
  // ters sıralı ve taşan koordinatlar düzeltilir
  const r = normalizeItem({ box_2d: [600, 800, -50, 100], translation: 'x' }, { order: 'yxyx' });
  assert.deepEqual(r.box, [0.1, 0, 0.8, 0.6]);
});

test('cleanHex', () => {
  assert.equal(cleanHex('#ABC'), '#aabbcc');
  assert.equal(cleanHex('112233'), '#112233');
  assert.equal(cleanHex('white'), '#ffffff');
  assert.equal(cleanHex('rgb(1,2,3)'), null);
  assert.equal(cleanHex(5), null);
});

// ================================================================ istem ve sağlayıcılar
test('buildPrompt: sözlük ve koordinat modu', () => {
  const p = buildPrompt({ provider: 'gemini', glossary: 'Hunter = Avcı\nçöp satır\nGate = Kapı' });
  assert.match(p, /ymin, xmin, ymax, xmax/);
  assert.match(p, /Hunter = Avcı/);
  assert.match(p, /Gate = Kapı/);
  assert.doesNotMatch(p, /çöp satır/);
  const q = buildPrompt({ provider: 'ollama', coordMode: 'absolute', width: 896, height: 1200 });
  assert.match(q, /896x1200/);
  assert.match(buildPrompt({ provider: 'ollama', coordMode: 'relative1000' }), /0-1000/);
});

test('buildGeminiRequest: şema ve görsel parçası', () => {
  const r = buildGeminiRequest({ base64: 'AAAA', mime: 'image/jpeg', glossary: '' });
  assert.equal(r.generationConfig.responseMimeType, 'application/json');
  assert.equal(r.contents[0].parts[1].inline_data.data, 'AAAA');
  assert.ok(r.generationConfig.responseSchema.properties.texts);
});

test('classifyGeminiError: dakikalık vs günlük kota (429)', () => {
  const minute = classifyGeminiError(429, {
    error: {
      message: 'Quota exceeded',
      details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' },
      ],
    },
  });
  assert.equal(minute.code, ERR.QUOTA_MINUTE);
  assert.equal(minute.retryAfterMs, 34000);

  const daily = classifyGeminiError(429, {
    error: {
      message: 'Quota exceeded',
      details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }],
    },
  });
  assert.equal(daily.code, ERR.QUOTA_DAILY);

  assert.equal(classifyGeminiError(400, { error: { message: 'API key not valid. Please pass a valid API key.' } }).code, ERR.AUTH);
  assert.equal(classifyGeminiError(403, {}).code, ERR.AUTH);
  assert.equal(classifyGeminiError(404, {}).code, ERR.MODEL_NOT_FOUND);
  assert.equal(classifyGeminiError(503, {}).code, ERR.SERVER);
  assert.equal(classifyGeminiError(400, { error: { message: 'bad' } }).code, ERR.BAD_RESPONSE);
});

test('AppError.toJSON: fatal / transient bayrakları', () => {
  assert.equal(new AppError(ERR.QUOTA_DAILY).toJSON().fatal, true);
  assert.equal(new AppError(ERR.NETWORK).toJSON().fatal, true);
  assert.equal(new AppError(ERR.SERVER).toJSON().transient, true);
  assert.equal(new AppError(ERR.IMAGE_FETCH).toJSON().fatal, false);
});

test('parseGeminiResponse', () => {
  const body = {
    candidates: [
      {
        finishReason: 'STOP',
        content: { parts: [{ text: '{"texts":[{"box_2d":[100,100,200,400],"original":"Hello","translation":"Merhaba","kind":"speech"}]}' }] },
      },
    ],
  };
  const r = parseGeminiResponse(body);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].translation, 'Merhaba');
  assert.ok(parseGeminiResponse({ promptFeedback: { blockReason: 'SAFETY' } }).warning);
  assert.equal(parseGeminiResponse({ candidates: [{ content: { parts: [{ text: '' }] } }] }).items.length, 0);
  assert.throws(() => parseGeminiResponse({ candidates: [{ content: { parts: [{ text: 'saçma' }] } }] }), (e) => e.code === ERR.BAD_RESPONSE);
});

test('parseOllamaResponse: göreli ve mutlak koordinatlar', () => {
  const content = JSON.stringify({ texts: [{ box_2d: [100, 200, 500, 400], original: 'A', translation: 'B' }] });
  const rel = parseOllamaResponse({ message: { content } }, { coordMode: 'relative1000', width: 800, height: 1200 });
  assert.deepEqual(rel.items[0].box, [0.1, 0.2, 0.5, 0.4]);
  const abs = parseOllamaResponse({ message: { content } }, { coordMode: 'absolute', width: 1000, height: 500 });
  assert.deepEqual(abs.items[0].box, [0.1, 0.4, 0.5, 0.8]);
});

// ================================================================ ayarlar
test('deepMerge / publicSettings', () => {
  const m = deepMerge(DEFAULTS, { gemini: { apiKey: 'K' }, sites: [{ host: 'a.com' }] });
  assert.equal(m.gemini.apiKey, 'K');
  assert.equal(m.gemini.model, DEFAULTS.gemini.model, 'verilmeyen alanlar varsayılanı korur');
  assert.equal(m.sites.length, 1);
  const pub = publicSettings(m);
  assert.equal(pub.gemini.apiKey, undefined, 'API anahtarı dışarı verilmez');
  assert.equal(pub.gemini.apiKeySet, true);
});

// ================================================================ kota
const { reserve, markBlocked, isBlocked, getUsage, resetBlocks } = await import('../background/quota.js');

test('quota: günlük sınır aşılınca LOCAL_CAP; allowPaid ile sınır kalkar', async () => {
  for (const k of Object.keys(store)) delete store[k];
  const limits = { dailyRequestCap: 3, allowPaid: false };
  await reserve('m', limits);
  await reserve('m', limits);
  await reserve('m', limits);
  await assert.rejects(reserve('m', limits), (e) => e.code === ERR.LOCAL_CAP);
  assert.equal((await getUsage()).counts.m, 3, 'reddedilen istek sayılmaz');
  await reserve('m', { dailyRequestCap: 3, allowPaid: true });
  assert.equal((await getUsage()).counts.m, 4);
  // modeller birbirinden bağımsız
  await reserve('other', limits);
});

test('quota: engellenen model reserve edilemez; resetBlocks açar', async () => {
  for (const k of Object.keys(store)) delete store[k];
  await markBlocked('m');
  assert.equal(await isBlocked('m'), true);
  await assert.rejects(reserve('m', { dailyRequestCap: 99, allowPaid: false }), (e) => e.code === ERR.QUOTA_DAILY);
  await resetBlocks();
  assert.equal(await isBlocked('m'), false);
});

test('quota: eşzamanlı reserve çağrıları yarışmaz', async () => {
  for (const k of Object.keys(store)) delete store[k];
  await Promise.all(Array.from({ length: 20 }, () => reserve('m', { dailyRequestCap: 1000, allowPaid: false })));
  assert.equal((await getUsage()).counts.m, 20);
});

// ================================================================ önbellek (IndexedDB taklidi)
const cache = await import('../background/cache.js');

test('cache: anahtar normalizasyonu ve hash', async () => {
  const a = await cache.urlKey('https://cdn.site.com/a/1.jpg?token=aaa&exp=1');
  const b = await cache.urlKey('https://cdn.site.com/a/1.jpg?token=bbb&exp=2#frag');
  const c = await cache.urlKey('https://cdn.site.com/a/2.jpg?token=aaa');
  assert.equal(a, b, 'görsel uzantılı URL: sorgu dizesi önemsiz');
  assert.notEqual(a, c);
  const d = await cache.urlKey('https://site.com/img?id=1');
  const e = await cache.urlKey('https://site.com/img?id=2');
  assert.notEqual(d, e, 'uzantısız URL: sorgu dizesi korunur');

  const h1 = await cache.sha256Hex(new Uint8Array([1, 2, 3]).buffer);
  const h2 = await cache.sha256Hex(new Uint8Array([1, 2, 3]).buffer);
  assert.equal(h1, h2);
  assert.equal(h1.length, 32);
});

test('cache: IndexedDB put/get/count/clear', { skip: !HAS_IDB && 'fake-indexeddb kurulu değil (npm install)' }, async () => {
  await cache.cacheClear();
  assert.equal(await cache.cacheGet('x'), null);
  await cache.cachePut('x', { boxes: [1] });
  assert.deepEqual(await cache.cacheGet('x'), { boxes: [1] });
  assert.equal(await cache.cacheCount(), 1);
  await cache.cacheClear();
  assert.equal(await cache.cacheCount(), 0);
});

// ================================================================ pipeline: ücret koruması ve yedek model
const { runGemini, assertProviderReady } = await import('../background/pipeline.js');

function geminiSettings(over = {}) {
  const base = deepMerge(DEFAULTS, {
    gemini: { apiKey: 'K', model: 'A', fallbackModel: 'B', confirmedFreeTier: true },
    limits: { dailyRequestCap: 100, minIntervalMs: 0, allowPaid: false },
  });
  return deepMerge(base, over);
}
const okBody = {
  candidates: [{ content: { parts: [{ text: '{"texts":[{"box_2d":[0,0,100,100],"original":"a","translation":"b"}]}' }] } }],
};
const dailyBody = {
  error: { message: 'quota', details: [{ '@type': 'x/QuotaFailure', violations: [{ quotaId: 'RequestsPerDay-FreeTier' }] }] },
};
const img = { base64: 'AAAA', mime: 'image/jpeg', width: 10, height: 10 };

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(url);
    const { status, body } = handler(url, calls.length);
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  return calls;
}

test('assertProviderReady: anahtar yok / ücretsiz onayı yok', () => {
  assert.throws(() => assertProviderReady(deepMerge(DEFAULTS, {})), (e) => e.code === ERR.NO_API_KEY);
  assert.throws(
    () => assertProviderReady(deepMerge(DEFAULTS, { gemini: { apiKey: 'K' } })),
    (e) => e.code === ERR.FREE_TIER_UNCONFIRMED,
  );
  assertProviderReady(geminiSettings()); // hata fırlatmamalı
  assertProviderReady(deepMerge(DEFAULTS, { gemini: { apiKey: 'K' }, limits: { allowPaid: true } }));
  assertProviderReady(deepMerge(DEFAULTS, { provider: 'ollama' }));
});

test('runGemini: ana modelin günlük kotası bitince YEDEK (ücretsiz) modele geçer, sonra durur', async () => {
  for (const k of Object.keys(store)) delete store[k];
  const calls = mockFetch((url) => (url.includes('/models/A:') ? { status: 429, body: dailyBody } : { status: 200, body: okBody }));
  const r = await runGemini(img, geminiSettings());
  assert.equal(r.model, 'B');
  assert.equal(r.items.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(await isBlocked('A'));

  // A bugün işaretlendi: sonraki çağrı A'ya HİÇ istek atmaz.
  calls.length = 0;
  await runGemini(img, geminiSettings());
  assert.ok(calls.every((u) => u.includes('/models/B:')));
});

test('runGemini: iki model de doluysa QUOTA_DAILY fırlatır ve başka yere gitmez', async () => {
  for (const k of Object.keys(store)) delete store[k];
  const calls = mockFetch(() => ({ status: 429, body: dailyBody }));
  await assert.rejects(runGemini(img, geminiSettings()), (e) => e.code === ERR.QUOTA_DAILY);
  assert.equal(calls.length, 2, 'her model için tam 1 deneme, tekrar yok');
  calls.length = 0;
  await assert.rejects(runGemini(img, geminiSettings()), (e) => e.code === ERR.QUOTA_DAILY);
  assert.equal(calls.length, 0, 'bloklu modellere istek atılmaz');
});

test('runGemini: yerel günlük sınır dolunca HİÇ istek atılmaz (LOCAL_CAP)', async () => {
  for (const k of Object.keys(store)) delete store[k];
  const calls = mockFetch(() => ({ status: 200, body: okBody }));
  const s = geminiSettings({ limits: { dailyRequestCap: 1, minIntervalMs: 0, allowPaid: false }, gemini: { fallbackModel: '' } });
  await runGemini(img, s);
  await assert.rejects(runGemini(img, s), (e) => e.code === ERR.LOCAL_CAP);
  assert.equal(calls.length, 1);
});

test('runGemini: geçersiz anahtar hatası yedek modele geçmeden doğrudan yükselir', async () => {
  for (const k of Object.keys(store)) delete store[k];
  const calls = mockFetch(() => ({ status: 403, body: { error: { message: 'denied' } } }));
  await assert.rejects(runGemini(img, geminiSettings()), (e) => e.code === ERR.AUTH);
  assert.equal(calls.length, 1);
});

// ================================================================ hız sınırı (429) davranışı
const sched = await import('../background/scheduler.js');
const gem = await import('../background/providers/gemini.js');
const { getLog, clearLog } = await import('../background/log.js');

const minuteBody = (sec) => ({
  error: {
    message: 'rate',
    details: [
      { '@type': 'x/QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] },
      { '@type': 'x/RetryInfo', retryDelay: `${sec}s` },
    ],
  },
});

function mockFetchBodies(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: init?.body ? JSON.parse(init.body) : null, at: Date.now() });
    const { status, body } = handler(calls.length, url);
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  };
  return calls;
}

test('429 (dakikalık): kuyruktaki istekler boşuna denemez; ortak soğuma uygulanır, reddedilen istek kotadan sayılmaz', async () => {
  for (const k of Object.keys(store)) delete store[k];
  sched._resetPacing();
  const calls = mockFetchBodies((n) => (n === 1 ? { status: 429, body: minuteBody(1) } : { status: 200, body: okBody }));
  const s = geminiSettings({ gemini: { fallbackModel: '' } });
  const t0 = Date.now();
  const results = await Promise.all([runGemini(img, s), runGemini(img, s), runGemini(img, s)]);
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.items.length === 1));
  assert.equal(calls.length, 4, '1 reddedilen + 3 başarılı; soğuma sırasında ek istek atılmamalı');
  const afterFirst = calls.slice(1).every((c) => c.at - calls[0].at >= 1900);
  assert.ok(afterFirst, 'ilk 429’dan sonra en az retryDelay+1sn beklenmeli');
  assert.equal((await getUsage()).counts.A, 3, 'reddedilen istek sayaçtan iade edilir');
  assert.ok(Date.now() - t0 >= 1900);
  assert.equal(sched.getPacing().penalized, true, 'aralık otomatik büyür');
});

test('scheduler: ceza her 429 ile ikiye katlanır, tavanı var, başarıyla azalır', () => {
  sched._resetPacing();
  sched.noteRateLimited(0);
  assert.equal(sched.getPacing().intervalMs, 12000);
  sched.noteRateLimited(0);
  assert.equal(sched.getPacing().intervalMs, 24000);
  for (let i = 0; i < 6; i++) sched.noteRateLimited(0);
  assert.equal(sched.getPacing().intervalMs, 60000);
  for (let i = 0; i < 80; i++) sched.noteSuccess();
  assert.equal(sched.getPacing().penalized, false);
  sched._resetPacing();
});

test('thinkingConfig reddedilirse alan kapatılıp istek yeniden gönderilir', async () => {
  for (const k of Object.keys(store)) delete store[k];
  sched._resetPacing();
  gem._resetThinkingConfig();
  const calls = mockFetchBodies((n) =>
    n === 1
      ? { status: 400, body: { error: { message: 'Invalid JSON payload received. Unknown name "thinkingConfig"' } } }
      : { status: 200, body: okBody },
  );
  const r = await runGemini(img, geminiSettings({ gemini: { fallbackModel: '' } }));
  assert.equal(r.items.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.generationConfig.thinkingConfig, 'ilk istek thinkingConfig içerir');
  assert.equal(calls[1].body.generationConfig.thinkingConfig, undefined, 'ikinci istek içermez');
  gem._resetThinkingConfig();
});

test('istek günlüğü: başarılı ve başarısız istekler kaydedilir, içerik kaydedilmez', async () => {
  for (const k of Object.keys(store)) delete store[k];
  sched._resetPacing();
  await clearLog();
  mockFetchBodies((n) => (n === 1 ? { status: 503, body: { error: { message: 'overloaded' } } } : { status: 200, body: okBody }));
  await runGemini(img, geminiSettings({ gemini: { fallbackModel: '' } }));
  const log = await getLog();
  assert.equal(log.length, 2);
  assert.equal(log[0].ok, false);
  assert.equal(log[0].code, ERR.SERVER);
  assert.equal(log[1].ok, true);
  assert.ok(!JSON.stringify(log).includes('AAAA'), 'görsel verisi günlüğe girmez');
  assert.ok(!JSON.stringify(log).includes('"K"'), 'API anahtarı günlüğe girmez');
});

test('"art" türü (çizim içi yazı) korunur ve istem bunu tarif eder', () => {
  const it = normalizeItem({ box_2d: [10, 10, 50, 200], translation: 'Not al', kind: 'art' }, { order: 'yxyx' });
  assert.equal(it.kind, 'art');
  assert.match(buildPrompt({ provider: 'gemini' }), /"kind": "art"/);
  assert.match(buildPrompt({ provider: 'ollama' }), /sfx \| art/);
});
