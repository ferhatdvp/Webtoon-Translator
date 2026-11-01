// popup/popup.js — araç çubuğu penceresi: site ekle/çıkar, çeviriyi aç/kapat, durum ve kota özeti.

import { getSettings, saveSettings } from '../shared/settings.js';
import { findSite, normalizeHost } from '../shared/sites.js';

const $ = (id) => document.getElementById(id);
let tab = null;
let settings = null;

async function activeTab() {
  const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
  return t || null;
}

async function tabMessage(msg) {
  if (!tab?.id) return null;
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch {
    return null; // bu sekmede içerik betiği yok
  }
}

async function refresh() {
  settings = await getSettings();
  $('master').checked = settings.enabled;

  // ---- bu sayfa ----
  const url = tab?.url || '';
  const isWeb = /^https?:/i.test(url);
  const host = isWeb ? normalizeHost(url) : null;
  $('siteHost').textContent = host || 'Desteklenmeyen sayfa';
  const site = isWeb ? findSite(settings.sites, url) : null;

  $('btnSite').hidden = !isWeb;
  $('siteEnabledWrap').hidden = !site;
  $('pageCard').hidden = true;

  if (!isWeb) {
    $('siteMsg').textContent = 'Yalnızca http/https sayfaları eklenebilir.';
  } else if (!site) {
    $('siteMsg').textContent = 'Bu site izin verilen siteler listesinde değil; eklenti burada çalışmaz.';
    $('btnSite').textContent = 'Bu siteyi ekle';
    $('btnSite').className = 'primary';
  } else {
    $('siteMsg').textContent = site.enabled ? 'İzinli — bu sitede çeviri çalışır.' : 'Listede ama devre dışı.';
    $('btnSite').textContent = 'Siteyi listeden çıkar';
    $('btnSite').className = 'danger';
    $('siteEnabled').checked = site.enabled;
  }

  // ---- sayfa durumu (içerik betiğinden) ----
  if (site && site.enabled && settings.enabled) {
    const st = await tabMessage({ type: 'GET_STATUS' });
    if (st?.ok) {
      $('pageCard').hidden = false;
      const s = st.stats;
      $('pageStatus').textContent = st.paused
        ? '⚠ Duraklatıldı: ' + (st.pauseInfo?.message || '')
        : `${s.done}/${s.total} görsel çevrildi` + (s.busy ? ` · ${s.busy} sırada` : '') + (s.failed ? ` · ${s.failed} başarısız` : '');
      $('btnToggle').textContent = st.visible ? 'Çeviriyi gizle' : 'Çeviriyi göster';
      $('btnAfk').textContent = st.afk ? 'AFK modunu durdur' : 'AFK modunu başlat';
      $('btnAfkReturn').hidden = !st.hasAfkStart;
    } else {
      $('siteMsg').textContent += ' (Sayfayı yenileyin.)';
    }
  }

  // ---- sağlayıcı ----
  const state = await chrome.runtime.sendMessage({ type: 'GET_STATE' });
  if (state?.ok) {
    const s = state.settings;
    const model = s.provider === 'ollama' ? s.ollama.model : s.gemini.model;
    $('provider').textContent = (s.provider === 'ollama' ? 'Ollama (yerel)' : 'Gemini (AI Studio)') + ' · ' + model;

    const lines = [];
    if (s.provider === 'gemini') {
      const counts = state.usage?.counts || {};
      const used = counts[s.gemini.model] || 0;
      const cap = s.limits.allowPaid ? '∞' : s.limits.dailyRequestCap;
      lines.push(`Bugün ${used}/${cap} istek`);
      if (state.usage?.blocked?.[s.gemini.model]) lines.push('günlük kota doldu');
    }
    lines.push(`önbellekte ${state.cacheCount} kayıt`);
    $('usage').textContent = lines.join(' · ');

    // hız sınırı / son hata bilgisi
    const pace = [];
    const now = Date.now();
    if (state.pacing?.cooldownUntil > now) {
      pace.push(`⏳ Dakikalık sınır: yaklaşık ${Math.ceil((state.pacing.cooldownUntil - now) / 1000)} sn bekleniyor`);
    } else if (state.pacing?.penalized) {
      pace.push(`İstekler ${Math.round(state.pacing.intervalMs / 1000)} sn aralıkla yavaşlatıldı (dakikalık sınır)`);
    }
    const lastErr = [...(state.lastLog || [])].reverse().find((e) => !e.ok && now - e.t < 10 * 60 * 1000);
    if (lastErr) pace.push(`Son hata: ${lastErr.code || 'hata'}${lastErr.status ? ' (' + lastErr.status + ')' : ''}`);
    $('pace').textContent = pace.join(' · ');

    $('warn').hidden = state.ready;
    if (!state.ready) $('warn').textContent = state.readyError?.message || '';
  }
}

// ---------------------------------------------------------------- olaylar

$('master').addEventListener('change', async (e) => {
  await saveSettings({ enabled: e.target.checked });
  refresh();
});

$('btnSite').addEventListener('click', async () => {
  const url = tab?.url || '';
  const host = normalizeHost(url);
  if (!host) return;
  const site = findSite(settings.sites, url);

  if (site) {
    await saveSettings({ sites: settings.sites.filter((s) => s.host !== site.host) });
  } else {
    // İzin isteği kullanıcı hareketinin hemen içinde, ilk await olarak yapılmalı.
    const granted = await chrome.permissions.request({ origins: ['<all_urls>'] });
    if (!granted) {
      $('siteMsg').textContent = 'Site erişim izni verilmedi; site eklenemedi.';
      return;
    }
    await saveSettings({ sites: [...settings.sites, { host, enabled: true, addedAt: Date.now() }] });
  }
  // Arka plan, içerik betiğini kaydedene kadar kısa bekle, sonra yenile.
  setTimeout(refresh, 400);
});

$('siteEnabled').addEventListener('change', async (e) => {
  const site = findSite(settings.sites, tab.url);
  if (!site) return;
  await saveSettings({
    sites: settings.sites.map((s) => (s.host === site.host ? { ...s, enabled: e.target.checked } : s)),
  });
  setTimeout(refresh, 400);
});

$('btnToggle').addEventListener('click', async () => {
  await tabMessage({ type: 'TOGGLE' });
  refresh();
});

$('btnAfk').addEventListener('click', async () => {
  const st = await tabMessage({ type: 'GET_STATUS' });
  await tabMessage({ type: 'SET_AFK', enabled: !st?.afk });
  await refresh();
});

$('btnAfkReturn').addEventListener('click', async () => {
  await tabMessage({ type: 'RETURN_AFK_START' });
  window.close();
});

$('btnRescan').addEventListener('click', async () => {
  if (!confirm('Sayfadaki tüm görseller önbellek yok sayılarak yeniden çevrilecek ve API isteği harcayacak. Devam edilsin mi?')) return;
  await tabMessage({ type: 'RESCAN', force: true });
  setTimeout(refresh, 300);
});

$('openOptions').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

(async () => {
  tab = await activeTab();
  await refresh();
})();
