# Webtoon Çevirmen (EN → TR) — Chrome eklentisi

Seçtiğiniz webtoon sitelerindeki İngilizce görsellerdeki yazıları bulur, Türkçeye çevirir ve çeviriyi orijinal yazının üstüne yerleştirir.
Ücretsiz çalışır: **Gemini (Google AI Studio ücretsiz katman)** ya da **Ollama (yerel, kotasız)**.

## Kurulum

1. GitHub deposunda **Code → Download ZIP** seçeneğine tıklayın ve ZIP dosyasını indirin.
2. ZIP'i çıkarın. İçinde `manifest.json` ve `background/`, `content/`, `options/`, `popup/`, `shared/`, `icons/` klasörlerinin bulunduğu `Webtoon-Translator` klasörünü bulun.
3. Chrome'da `chrome://extensions` adresini açın, sağ üstten **Geliştirici modu**'nu etkinleştirin ve **Paketlenmemiş öğe yükle**'ye tıklayın.
4. `manifest.json` dosyasının bulunduğu **proje ana klasörünü** seçin (ZIP'in kendisini veya onun dışındaki üst klasörü seçmeyin). Kaynakları güncellediğinizde Chrome'daki eklenti kartının yenile düğmesine basın.
5. Eklenti simgesi → **⚙ Ayarlar**:
   - **Gemini**: <https://aistudio.google.com/apikey> adresinden ücretsiz anahtar alın, yapıştırın, "ücretsiz katman" onay kutusunu işaretleyin, **Bağlantıyı test et**.
   - **Ollama** (alternatif): `ollama pull qwen3-vl:8b`, sağlayıcı olarak Ollama'yı seçin.
6. Bir webtoon bölümü açın → eklenti simgesi → **Bu siteyi ekle** (bir kez izin ister) → sayfayı yenileyin.

Sağ altta **TR** düğmesi çıkar: tıklayınca çeviri gizlenir/gösterilir (kısayol: **Alt+T**). Kutunun üstüne gelince orijinal İngilizce metin görünür.

## Mimari

```
 Sayfa (yalnızca izinli siteler)                 Arka plan (service worker)                   Dış servis
┌─────────────────────────────┐   mesaj    ┌──────────────────────────────────────┐
│ content/content.js          │──────────▶│ service-worker.js  (yönlendirici)    │
│  • <img> tespiti (lazy-load)│           │   └ pipeline.js                      │
│  • görünür olanı sıraya al  │◀──────────│       1. cache.js  (URL/içerik hash) │
│  • kutuları yerleştir/sığdır│  kutular   │       2. net.js    (Referer ile indir)│
│  • aç/kapat, ipucu, bildirim│           │       3. geometry.js (parçalara böl) │──▶ Gemini API
└─────────────────────────────┘           │       4. providers/gemini | ollama   │──▶ Ollama (localhost)
 content/content.css (kutu stili)         │       5. quota.js  (günlük sayaç)    │
 popup/*  options/*  (arayüz)             │          scheduler.js (hız sınırı)   │
                                          └──────────────────────────────────────┘
```

Her istekte model **tek seferde** metin tespiti + koordinat + Türkçe çeviri döndürür (ayrı OCR gerekmez).

## Dosyalar

| Dosya | Görev |
|---|---|
| `manifest.json` | MV3 tanımı; izinler; Alt+T kısayolu |
| `shared/settings.js` | Varsayılanlar, ayar okuma/yazma |
| `shared/sites.js` | Site listesi, eşleştirme, match pattern üretimi |
| `shared/geometry.js` | Uzun görseli örtüşen parçalara bölme, kutu birleştirme/tekilleştirme |
| `shared/items.js` | Model çıktısını güvenle ayrıştırma (kesik JSON dahil) |
| `shared/errors.js` | Hata kodları ve Türkçe mesajlar |
| `background/service-worker.js` | Mesaj yönlendirme, içerik betiği kaydı, kısayol |
| `background/sites-sync.js` | İçerik betiğini yalnızca izinli sitelere kaydeder |
| `background/pipeline.js` | Uçtan uca işlem hattı + ücret koruması |
| `background/providers/gemini.js` / `ollama.js` | Sağlayıcılar |
| `background/prompts.js` | Modele gönderilen talimat (sözlük dahil) |
| `background/cache.js` | IndexedDB önbelleği |
| `background/log.js` | Son 60 isteğin tanılama günlüğü |
| `background/quota.js` / `scheduler.js` | Günlük sayaç / istek aralığı |
| `background/net.js` / `image.js` | Görsel indirme (Referer kuralı) / kırpma ve JPEG |
| `content/content.js` / `content.css` | Sayfa içi işlevler ve kutu stilleri |
| `popup/*`, `options/*` | Arayüz |
| `tests/unit.test.mjs` | Birim testleri (`npm install && npm test`) |

## İstekler → nerede karşılandı

1. Site listesi → `options` + `popup`, `shared/sites.js`
2. Yalnızca etkin sitelerde çalışma → statik content_script yok; `sites-sync.js` dinamik kaydeder; arka plan da her istekte siteyi doğrular
3. Görsel tespiti → `content.js` (IntersectionObserver + MutationObserver, lazy-load, `blob:`/`data:` desteği, küçük görselleri yok sayma)
4–5. Metin + koordinat + çeviri → `providers/*`, `prompts.js`
6–7. Yerleştirme/ölçekleme → kutular yüzde konumlu; yazı boyutu `calc(var(--wtt-w) * oran)` ile görselle birlikte ölçeklenir
8. Üstüne gelince orijinal metin → `content.js` ipucu
9. Aç/kapat → TR düğmesi, popup, Alt+T
10. Önbellek → `cache.js` (URL → içerik hash → parça bazlı)
11. Kota/bağlantı bildirimi → sağ altta bildirim + "Tekrar dene"; çevrimdışı olunca durur, bağlantı gelince devam eder
12. Ücretli kullanıma onaysız geçmeme → aşağıda

## Ücretli kullanıma karşı korumalar

- Gemini, ayarlarda "anahtarım ücretsiz katmanda" onayı verilmeden **hiç istek göndermez**.
- Günlük yerel sınır (varsayılan 500/model) dolunca durur. Sınırı kaldırmak için ayrı bir "ücretli kullanıma izin ver" kutusu vardır (uyarı ister, varsayılan kapalı).
- 429 (kota) gelince durur ve bildirir; günlük kota dolduysa o modeli gün sonuna kadar bir daha denemez.
- Tek otomatik geçiş: sizin tanımladığınız **yedek Gemini modeli** (ücretsiz katmanda modellerin kotası ayrıdır). Başka sağlayıcıya veya ücretli plana kendiliğinden geçilmez.
- **Asıl güvence:** Google Cloud projenizde faturalandırmayı hiç açmayın. Ücretsiz katmanda limit aşımı ücret değil 429 hatası üretir. Eklenti, anahtarınızın hangi katmanda olduğunu dışarıdan doğrulayamaz; bu yüzden onay kutusu var.

## Önden çeviri (varsayılan: açık)

Sayfa açılır açılmaz **tüm görseller sırayla** çeviriye alınır; sistem bir görsel bitince hemen sıradakine geçer, boşta kalmaz. Sıra: önce ekranda görünenler, sonra ekranın altındakiler sayfa sırasıyla, en son yukarıda kalanlar. Kaydırırken öncelik kendiliğinden güncellenir. Henüz yüklenmemiş (lazy-load) görseller de `data-src` gibi özelliklerinden bulunup önceden çevrilir.

Bedeli: okumayı yarıda bırakırsan sayfanın kalanı için de istek harcanmış olur (sonradan dönersen önbellekten gelir). Kota sıkışıksa Ayarlar → Görünüm → "Çeviri sırası"ndan "Yalnızca ekrana yakın görselleri" seçebilirsin.

## AFK modu

Eklenti penceresindeki **AFK modunu başlat** düğmesi sayfayı aşağı doğru kaydırır; bu, sitelerin lazy-load ile ertelediği görselleri yükletir. Görseller normal çeviri kuyruğundan ve önbellekten geçer. Sayfanın sonuna ulaşıp bekleyen çeviri kalmadığında eklenti `rel="next"` bağlantısını veya adı/etiketi "Next" olan bağlantıyı izleyerek sonraki bölümü açar. AFK açık durumu bölüm geçişlerinde korunur ve popup'tan durdurulabilir.

Güvenlik için tek çalıştırmada en fazla 20 bölüm geçişi yapılır. Çeviride hata kalırsa ilerleme bekler; sağlayıcı kotası nedeniyle duraklatılırsa kullanıcı devam ettirene kadar bölüm geçişi yapılmaz. Next bağlantısı güvenle belirlenemezse AFK durur; URL'deki sayıyı tahmin ederek değiştirmez. Kaydırma, sekmenin açık kalmasını gerektirir.

AFK ilk başlatıldığı bölümün adresini saklar. AFK durduktan sonra popup'taki **AFK başlangıç bölümüne dön** düğmesiyle oraya geri dönebilirsiniz.

## SFX ve çizim içi yazılar

Ses efektleri ve çizimin parçası olan yazılar (defterdeki el yazısı, tabela, ekran vb.) varsayılan olarak çevrilmez; Ayarlar → Görünüm'den açılabilir. Bu ayrımı modelin kendisi yapar, bu yüzden arada hatalı olabilir. Eski önbellekteki sayfalar eski sınıflandırmayla kalır; o sayfada popup → **Yeniden çevir** (istek harcar).

## Bilmeniz gerekenler

- **Gizlilik:** Gemini kullanırken görseller Google'a gönderilir. Ücretsiz katmanda Google verileri ürün geliştirme için kullanabilir. Gizlilik önemliyse Ollama kullanın.
- **Ücretsiz limitler değişir.** Güncel limitler için AI Studio → Rate limits sayfasına bakın. Varsayılan ana model `gemini-3.5-flash-lite`, yedek model `gemini-3.1-flash-lite` olarak ayarlanmıştır. Eklentideki günlük yerel sınır her model için 500 istektir; Google'ın gerçek kotası projeye göre değişebilir.
- Tipik bir bölüm 40–60 görsel = yaklaşık 40–60 istektir (çok uzun görseller parçalara bölündüğü için daha fazla). İlk okuma kotadan yer, sonraki açılışlar önbellekten gelir.
- **Ollama** koordinat doğruluğu Gemini'den düşük olabilir. `qwen3-vl` için "Göreli 0–1000", `qwen2.5-vl` için "Mutlak piksel" seçin.
- Bazı siteler görselleri CSS arka planı veya `<canvas>` ile gösterir; bunlar şimdilik algılanmaz. Bazı CDN'ler görseli yalnızca çok sıkı başlık kontrolüyle verir; indirme başarısız olursa bildirim çıkar.
- Aynı görseli farklı bir bölümde yeniden çevirmek için popup → **Yeniden çevir** (önbelleği yok sayar, istek harcar).

## Çeviri yavaş ya da hiç gelmiyorsa

1. Çevrilmekte olan görselin **üst kenarında** ⏳ Sırada… / Çevriliyor… rozeti görünür (ekrana yapışmaz, sayfayla kayar; çeviri bitince kalkar); hata olursa **⚠ Çevrilemedi — tıkla: tekrar dene**.
2. Eklenti simgesi → Sağlayıcı bölümü: "⏳ Dakikalık sınır: ~N sn bekleniyor" yazıyorsa Gemini ücretsiz katmanının **dakikadaki istek sınırına** takılmışsınız demektir. Eklenti bu durumda tüm kuyruğu soğutur ve istek aralığını otomatik büyütür (12 → 24 → 60 sn). Sınır düşükse bir bölüm uzun sürer; bu eklentinin değil ücretsiz katmanın sınırıdır.
3. Ayarlar → **7 · Tanılama**: son istekleri, hata kodlarını ve sürelerini gösterir. Kendi limitlerinizi AI Studio → Rate limit sayfasından görün.
4. Hızı artırmak için Ayarlar'da istekler arası süreyi düşürebilirsiniz; Google'ın dakikalık kotası aşılırsa eklenti kuyruğu otomatik yavaşlatır.

