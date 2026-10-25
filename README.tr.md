<p align="center">
  <img src="branding/banner/backdraw-banner.png" alt="Backdraw" width="100%">
</p>

<p align="center">
  <b>Claude, kendi ChatGPT hesabınla, Chrome'da arka plandaki bir sekmede görsel üretsin.<br>API anahtarı yok, ek ücret yok, başında beklemene gerek yok.</b>
</p>

<p align="center">
  <img src="branding/demo/backdraw-demo.gif" alt="Web'deki görseller sağ tıkla referans olarak kaydediliyor, sonra Claude Code Backdraw'dan o tarzda bir görsel istiyor; ChatGPT görseli arka plan sekmesinde çiziyor ve dosya bilgisayara kaydediliyor" width="100%">
</p>

<p align="center"><a href="README.md">English</a></p>

---

## Ne yapar?

Backdraw, bilgisayarında çalışan bir MCP sunucusu ve bir Chrome eklentisinden oluşur. Claude'dan
"ChatGPT ile" bir görsel istediğinde Backdraw, zaten giriş yapmış olduğun Chrome'da ChatGPT'yi arka
plandaki bir sekmede açar. İstemi gönderir, görseli bekler ve bilgisayarına kaydeder. Claude'a dosya
yolu, bir önizleme ve sohbetin bağlantısı döner.

- Yeni görseller üret ya da bir görseli referans olarak ekleyip düzenlet.
- Bir en-boy oranı (`16:9`, banner için `4:1`, …) ya da şeffaf arka plan iste.
- Herhangi bir sitedeki görselleri sağ tıklayarak kaydet, koleksiyon olarak tekrar tekrar kullan.
- Ürettiğin her şeye galeri yan panelinden göz at.
- Saf Node.js, sıfır npm bağımlılığı. Her şey senin bilgisayarında çalışır.

> **Kişisel kullanım içindir: kendi ChatGPT hesabınla ve riski sana ait olarak.** ChatGPT web
> sayfasını otomatikleştirmek OpenAI'ın koşullarıyla çelişebilir; başlamadan önce
> [Sorumluluk reddi ve sorumlu kullanım](#sorumluluk-reddi-ve-sorumlu-kullanım) bölümünü oku.

## Neden Backdraw?

- **Her gün kullandığın Chrome.** Ayrı bir tarayıcı profili, ikinci bir giriş ya da otomasyon
  tarayıcısı yok: Backdraw, ChatGPT'ye zaten giriş yapmış olduğun Chrome'da çalışır.
- **Seni rahatsız etmez.** İş, sessize alınmış ve hiç odak almayan bir arka plan sekmesinde yapılır;
  görsel hazırlanırken sen çalışmaya devam edersin.
- **Açık port yok.** Parçalar Chrome native messaging ve yalnızca senin Windows kullanıcının
  açabildiği bir named pipe üzerinden konuşur. DevTools portu (9222 gibi) ya da yerel bir web
  sunucusu yoktur.
- **API anahtarı yok.** ChatGPT planını kullanır; her görsel normal ChatGPT limitlerinden düşer.
- **Web'den referanslar.** Herhangi bir sitedeki görselleri sağ tıklayarak topla, sonra onların
  tarzında üret.
- Ürettiğin her şey için Chrome'un yan panelinde bir **galeri**.
- **Tek komutla kurulum:** `npx backdraw@latest setup`. Sana kalan tek adım eklentiyi yüklemek.

### Benzer projelerle karşılaştırma

Diğer açık kaynak projeler farklı yollar izliyor ve birçoğu Backdraw'ın yapmadığı şeyleri yapıyor
(macOS ya da Linux desteği, API modu, bir sunucuda çalışma). Her satır 25 Ekim 2026'da projenin
README'si ve kaynak koduyla kontrol edildi; **?** emin olamadığımız yerler. Bir hata mı gördün?
Lütfen bir [issue aç](../../issues).

| Proje | Her gün kullandığın Chrome (ayrı profil ya da giriş yok) | Arka plan sekmesi (odak çalmaz) | Açık port | API anahtarı gerekir mi | Sağ tıkla referans koleksiyonu | Galeri | Platformlar |
|---|---|---|---|---|---|---|---|
| **Backdraw** | Evet | Evet | Yok (native messaging + named pipe) | Hayır | Evet | Evet | Windows |
| [lownamlee/gpt-image-2-mcp](https://github.com/lownamlee/gpt-image-2-mcp) | Hayır (kendi tarayıcı profili) | Kısmen¹ | Yok | İsteğe bağlı (API modu) | Hayır | Hayır | ? |
| [nothariharan/image-gen](https://github.com/nothariharan/image-gen) | Hayır (kendi Edge profili) | Hayır | Var (CDP 9222) | Hayır | Hayır | Hayır | Windows; macOS/Linux elle |
| [goofyshwetank/mcp-chatgpt-gemini-image](https://github.com/goofyshwetank/mcp-chatgpt-gemini-image) | Hayır (kendi Chromium profili) | Hayır | Yok | Hayır | Hayır | Hayır | ? |
| [Dasemu/chatgpt-imagegen-mcp](https://github.com/Dasemu/chatgpt-imagegen-mcp) | Hayır (kendi profili, bir sunucuda) | Kısmen² | Var (HTTP 8088, uzak sunucu) | Hayır (kendi sunucu token'ı) | Hayır | Hayır | Linux sunucu |
| [Codex'in yerleşik `$imagegen`'i](https://learn.chatgpt.com/codex/image-generation) | – (tarayıcı yok) | – | Yok | Hayır (Codex girişi) | Hayır | ? | ? |
| [Sateezg/codex-bridge](https://github.com/Sateezg/codex-bridge) | – (tarayıcı yok, Codex'i çalıştırır) | – | Yok | Hayır (Codex girişi) | Hayır | Hayır | macOS, Linux |

¹ Kendi tarayıcı penceresi; ChatGPT hazır olunca ekran dışına taşınır ya da simge durumuna küçültülür.
² Sunucuda sanal bir ekranda (Xvfb) ya da başsız (headless) çalışan bir tarayıcı.

Codex kullanıcılarının zaten yerleşik bir görsel üretimi var; Backdraw esas olarak Claude Code,
Claude masaüstü uygulaması ve VS Code içindir.

## Nasıl çalışır?

```
Claude Code / Claude masaüstü uygulaması (MCP istemcisi)
        │  stdio üzerinden MCP
        ▼
  mcp-server.js ──── named pipe, yalnızca senin Windows kullanıcın ────►  host.js
                                                                           │  Chrome native messaging
                                                                           ▼
                                                               Backdraw Chrome eklentisi
                                                                           │  arka plan sekmesi
                                                                           ▼
                                             chatgpt.com → Projen → yeni sohbet → görsel
```

- `mcp-server.js`, Claude'un konuştuğu parçadır. Her araç çağrısını `host.js`'e iletir.
- `host.js`'i, eklenti bağlandığında Chrome başlatır. İş kuyruğunu yürütür (aynı anda tek iş),
  görselleri kaydeder ve iş geçmişini `%USERPROFILE%\.backdraw\data` içinde tutar.
- Eklenti chatgpt.com'u, seçtiğin ChatGPT Projesi içinde bir **arka plan sekmesinde** açar. Sekme
  hiçbir zaman öne gelmez ve sessize alınır, hiçbir pencere odak almaz, fare ve klavyen kullanılmaz:
  yalnızca o sekmenin içinde sentetik olaylar kullanılır. İş bitince sekme kapanır; o an o sekmeye
  bakıyorsan açık bırakılır.
- **API anahtarı gerekmez.** Backdraw, Chrome'da zaten açık olan ChatGPT oturumunu kullanır. Cookie,
  token ya da şifre asla okunmaz.
- **ChatGPT'ye gönderdiklerin (istem ve varsa referans görseller) dışında hiçbir şey bilgisayarından
  çıkmaz.** Backdraw'ın bir sunucusu yok, telemetri de yok.

Görseller Resimler klasöründe `Backdraw` altına, saat ve istemden oluşan bir adla kaydedilir, örneğin
`20261021-153012_a-cozy-reading-nook.png`.

## Gereksinimler

| | |
|---|---|
| İşletim sistemi | Windows 10 ya da 11 |
| Tarayıcı | Google Chrome 116 ya da daha yeni (Edge, Brave ve Chromium için de kayıt yapılır ama yalnızca Chrome'da denendi) |
| Çalışma ortamı | Node.js 20 ya da daha yeni |
| Hesap | Görsel üretebilen, Chrome'da giriş yapılmış bir ChatGPT hesabı |
| İstemci | Claude Code, Claude masaüstü uygulaması, Codex, Cursor, VS Code ya da Gemini CLI (veya stdio sunucusu çalıştırabilen başka bir MCP istemcisi) |

Şimdilik yalnızca Windows. Kod bir platform modülüne ayrılmış durumda; macOS/Linux katkılarına
açığız. İşletim sistemine özgü her şey (named pipe, native host kaydı, kullanıcı klasörleri)
`platform/win32.js` içinde.

## Kurulum

### Hızlı kurulum

Bunu PowerShell'de ya da cmd'de çalıştır (yönetici izni gerekmez):

```
npx backdraw@latest setup
```

`setup`, tarayıcıdaki tek bir tıklama dışında her şeyi yapar:

1. Backdraw'ı `%USERPROFILE%\.backdraw` klasörüne kopyalar (npx'in kendi kopyası geçicidir) ve görsel
   klasörünü `Pictures\Backdraw` olarak ayarlar (referans koleksiyonları `Pictures\Backdraw\References`
   altına gider). Yeniden çalıştırınca Backdraw'ı günceller; ayarların, iş geçmişin ve
   koleksiyonların korunur.
2. Native messaging host'u senin Windows kullanıcın için, bulduğu her tarayıcıya (Chrome, Edge,
   Brave, Chromium) kaydeder.
3. Bulduğu MCP istemcilerini (Claude Code, Claude masaüstü uygulaması, Codex, Cursor, VS Code,
   Gemini CLI) listeler ve Backdraw'ın hangilerine ekleneceğini sorar. Yalnızca `backdraw` girdisi
   eklenir ya da güncellenir; her ayar dosyasının değişmeden önce zaman damgalı bir `.bak` yedeği
   alınır. `--yes` bulduğu tüm istemcileri, `--clients=claude-code,cursor` tam olarak bunları seçer.
4. Eklenti klasörünü ve tarayıcının eklentiler sayfasını açar, klasör yolunu panoya kopyalar ve
   sana kalan tek adımı, **eklentiyi yüklemeni** bekler:
   1. **Geliştirici modu**nu aç (sağ üstte),
   2. **Paketlenmemiş öğe yükle**ye tıkla,
   3. klasörü seç (yolu Ctrl+V ile yapıştırabilirsin).

   Eklenti bağlandığı anda setup **✓ Ready** ve örnek bir istem yazar.

Native host'un adı, projenin eski GitHub kullanıcı adından gelen
`io.github.muhammedtalha04.backdraw` olarak kalıyor: adı değiştirmek mevcut kurulumları bozardı.

### Elle kurulum

1. **Kodu indir.** Depoyu git ile klonla ya da ZIP olarak indir (**Code** → **Download ZIP**) ve
   aç:

   ```
   git clone https://github.com/devtalh/backdraw.git
   cd backdraw
   ```
2. **Kurulumu çalıştır.** O klasörde (yönetici izni gerekmez):

   ```
   node install.js
   ```

   Yukarıdaki 1. ve 2. adımları yapar ve Backdraw'ı Claude Code'a ekler (kullanıcı düzeyinde).
   Diğer istemciler için bunun yerine `node bin/backdraw.js setup` çalıştır ya da
   [Kullanım](#kullanım) bölümüne bak.
3. **Eklentiyi bir kez yükle.** `chrome://extensions` sayfasını aç, **Geliştirici modu**nu aç,
   **Paketlenmemiş öğe yükle**ye tıkla ve `%USERPROFILE%\.backdraw\extension` klasörünü seç.

### Açılır pencerede bitir

1. **Açılır pencereyi aç.** Araç çubuğundaki Backdraw simgesine tıkla (yapboz menüsünden
   sabitleyebilirsin). Her şey hazır olana kadar pencerede, her adımın çözümüyle birlikte bir kurulum
   listesi görünür:
   1. köprü bağlı,
   2. ChatGPT'de giriş yapılmış,
   3. bir ChatGPT Projesi seçili,
   4. hazır: Claude'a yapıştırabileceğin örnek bir istem.
2. **Bir ChatGPT Projesi oluştur ve seç.** ChatGPT'de görsellerin için bir Proje oluştur (örneğin
   "Backdraw"), onu aç, Backdraw simgesine tıkla ve **“Backdraw” projesini kullan** düğmesine bas.
   Claude'a da söyleyebilirsin: *"ChatGPT'deki Backdraw projemi görseller için seç."* Her yeni
   görsel sohbeti o Projenin içinde açılır.

Açılır pencerede dil (Otomatik / English / Türkçe) ve tema (Otomatik / Açık / Koyu) ayarları da var.
Bir şey çalışmazsa [`npx backdraw@latest doctor`](#doktor) çalıştır.

## Kullanım

### Claude Code'dan

Kurulumdan sonra **yeni** bir Claude Code oturumu başlat (MCP sunucuları oturum açılırken yüklenir)
ve isteğini doğal dille, istediğin dilde yaz. `backdraw` sunucusu Claude'a şu araçları verir:
`generate_image`, `job_status`, `cancel_job`, `fetch_images`, `list_projects`, `select_project` ve
`list_collections` (bkz. [Araç başvurusu](#araç-başvurusu)).

### Claude masaüstü uygulamasından (sohbet)

Masaüstü uygulaması sohbetler için kendi MCP ayarlarını tutar. Claude bu dosyayı kapanırken yeniden
yazar; bu yüzden Backdraw onu yalnızca Claude kapalıyken değiştirir. Setup Claude'u açık bulduysa
Backdraw'ı sonra ekle:

1. Claude'u **tamamen** kapat, sistem tepsisinden de.
2. Şunu **PowerShell**'den çalıştır (bir Claude oturumundan değil):

   ```powershell
   npx backdraw@latest setup --clients=claude-desktop
   ```

   (Elle kurulumda: `~\.backdraw` içinde `node install.js --desktop`.) Her ayar dosyası
   değiştirilmeden önce zaman damgalı bir `.bak` yedeği alınır.
3. Claude'u yeniden başlat. Backdraw yeni sohbetlerde kullanılabilir.

### Başka MCP istemcilerinden

`setup`, Backdraw'ı Codex, Cursor, VS Code ve Gemini CLI'ye de ekler: sorduğunda onları seç ya da
`npx backdraw@latest setup --clients=codex,cursor,vscode,gemini` çalıştır. Komut olarak
`node.exe`'nin tam yolunu yazar; böylece `PATH`'ini görmeyen bir istemci de onu bulur. Sonra
istemciyi yeniden başlat ya da yeni bir oturum aç.

VS Code ve Gemini CLI, ayar dosyalarında yoruma izin verir. Böyle bir dosyayı yeniden yazmak
yorumları silerdi; bu yüzden setup yorum içeren bir dosyaya dokunmaz ve bunu söyler. O durumda
girdiyi elle ekle.

Backdraw sıradan bir stdio MCP sunucusudur: `node %USERPROFILE%\.backdraw\mcp-server.js`. Elle
eklemek için aşağıdaki örnekleri kullan. Ayar dosyalarında `C:/Users/you` yerine kendi kullanıcı
klasörünü yaz (cmd'de `echo %USERPROFILE%` gösterir). Eğik çizgi (`/`) Windows'ta çalışır ve JSON'da
kaçış gerektirmez. Aşağıdaki `~` senin kullanıcı klasörün. PowerShell komutları yolu kendileri
doldurur.

**Codex** (CLI, IDE eklentisi ve uygulama aynı `~\.codex\config.toml` dosyasını kullanır;
[belgeler](https://learn.chatgpt.com/docs/extend/mcp)). PowerShell'den:

```powershell
codex mcp add backdraw -- node "$env:USERPROFILE\.backdraw\mcp-server.js"
```

ya da `config.toml` içinde:

```toml
[mcp_servers.backdraw]
command = "node"
args = ["C:/Users/you/.backdraw/mcp-server.js"]
```

**Cursor** (tüm projeler için `~\.cursor\mcp.json`, tek proje için o projede `.cursor\mcp.json`;
[belgeler](https://cursor.com/docs/context/mcp)). Cursor `${userHome}` değişkenini kendisi doldurur:

```json
{
  "mcpServers": {
    "backdraw": {
      "type": "stdio",
      "command": "node",
      "args": ["${userHome}/.backdraw/mcp-server.js"]
    }
  }
}
```

**VS Code** (GitHub Copilot ajan modu: tüm çalışma alanları için **MCP: Open User Configuration**
komutunu çalıştır ya da bir çalışma alanında `.vscode\mcp.json` oluştur;
[belgeler](https://code.visualstudio.com/docs/copilot/customization/mcp-servers)). Burada anahtar
`servers`'tır ve `type` zorunludur:

```json
{
  "servers": {
    "backdraw": {
      "type": "stdio",
      "command": "node",
      "args": ["C:/Users/you/.backdraw/mcp-server.js"]
    }
  }
}
```

**Gemini CLI** (`~\.gemini\settings.json`;
[belgeler](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md)).
`-s user` onu tüm projeler için ekler (varsayılan yalnızca o anki projedir). PowerShell'den:

```powershell
gemini mcp add -s user backdraw node "$env:USERPROFILE\.backdraw\mcp-server.js"
```

ya da `settings.json` içinde:

```json
{
  "mcpServers": {
    "backdraw": {
      "command": "node",
      "args": ["C:/Users/you/.backdraw/mcp-server.js"]
    }
  }
}
```

## Örnek istemler

| Sen şöyle yazarsın | Claude `generate_image`'a şunu geçer |
|---|---|
| *ChatGPT ile bir görsel üret: yağmurlu bir pencerenin önünde sıcak lamba ışıklı, rahat bir okuma köşesi.* | ayrıntılı bir `prompt` |
| *ChatGPT ile blogum için 16:9 bir banner yap: "Gece Vardiyası Notları", alacakaranlıkta neon bir şehir.* | `aspect_ratio: "16:9"` |
| *ChatGPT ile şeffaf arka planlı, mutlu bir kaktüs çıkartması yap.* | `transparent_background: true` |
| *`C:\yol\foto.png` dosyasını ChatGPT ile düzenle: gökyüzünü gün batımına çevir, gerisi aynı kalsın.* | `reference_images: ["C:\\yol\\foto.png"]` |
| *"Kediler" koleksiyonumu referans alarak ChatGPT ile bir afiş yap.* | `reference_collection: "Kediler"` |

Bir görseli düzenletmek için Backdraw'ın onu bilgisayarındaki bir dosya olarak alması gerekir:
Claude'a dosyanın tam yolunu ver (yaz ya da yapıştır), Claude da onu `reference_images` ile
geçsin. Önceki çağrıların kaydettiği dosyalar doğrudan kullanılabilir. Düzenleme için en güvenilir
yol, görselin eklendiği yeni bir sohbettir.

*"ChatGPT görsel işinin durumu ne?"* ya da *"O işi iptal et."* diye de sorabilirsin.

## Referans koleksiyonları

Web'den görseller topla, sonra onları referans olarak kullan.

1. Herhangi bir web sayfasında bir görsele sağ tıkla → **Backdraw'a ekle** → bir koleksiyon seç ya
   da **Yeni koleksiyon…** (küçük bir pencere ad sorar).
2. Sayfada kısa bir not bunu onaylar, örneğin "Kediler koleksiyonuna eklendi · 5 görsel". Chrome'un
   eklentilerin bir şey göstermesine izin vermediği sayfalarda bunun yerine araç çubuğu simgesinde
   kısa bir ✓ (hata olursa kırmızı !) yanıp söner.
3. Claude'dan koleksiyonu adıyla kullanmasını iste.

Her koleksiyon bir klasördür: `Pictures\Backdraw\References\<koleksiyon>\`. İçinde görseller
(adlarını Backdraw verir: `001_<ad>.png`, …), her görselin kaynak sayfasını ve tarihini tutan bir
`collection.json` ve bir `thumbs\` klasörü bulunur. Aynı görseli bir koleksiyona iki kez eklersen tek
kopya tutulur. PNG, JPEG, WebP ve GIF olduğu gibi saklanır; Chrome'un gösterebildiği diğer biçimler
(AVIF, BMP ya da SVG gibi) PNG olarak kaydedilir. Bir görsel dosyasını elle silersen koleksiyondan da
düşer.

Açılır penceredeki **Koleksiyonlar** bölümü koleksiyonlarını listeler. Birini açınca küçük
resimlerini görebilir, görsel silebilir, koleksiyonu yeniden adlandırabilir ya da silebilirsin.

| Sınır | |
|---|---|
| Mesaj başına referans | 16 (`reference_images` ve koleksiyon görselleri birlikte; ChatGPT denemede 16'sını da kabul etti) |
| Tek referans | 20 MB |
| Bir mesajın tüm referansları | 80 MB |
| Tek koleksiyon görseli | 25 MB (20 MB'tan büyük bir görsel koleksiyonda kalır; isteklerde dışarıda bırakılır ve bu sonuçta yazılır, `reference_files` ile adı verilirse istek bir hata mesajıyla reddedilir) |

Bir istek, koleksiyonun boş yerlere sığan **en yeni** görsellerini kullanır. Belirli görselleri
istiyorsan adlarını söyle: Claude onların dosya adlarını (`list_collections`'tan) `reference_files`
ile geçer.

## Boyutlar ve şeffaflık

### `aspect_ratio`

Tam sayılarla `G:Y` (genişlik:yükseklik), `1:4` ile `4:1` arasında herhangi bir oran: `1:1`, `3:2`,
`2:3`, `4:5`, `16:9`, `9:16`, `5:2` (Discord banner), `3:1`, `4:1`, … `1920:1080` otomatik olarak
`16:9`'a sadeleşir; `1.5:1` değil `3:2` yaz. Birkaç ad da çalışır: `square`, `landscape` (3:2),
`portrait` (2:3), `wide` (16:9), `tall` (9:16), `discord-banner` (5:2).

- **1:3 ile 3:1 arası:** Bunları ChatGPT kendisi, istenen biçimde yaklaşık 1,57 megapiksel olarak
  çizer. Ekim 2026'da görülenler: 1254×1254 (1:1), 1536×1024 (3:2), 1672×941 (16:9), 1983×793 (5:2).
- **4:1 / 1:4'e kadar:** ChatGPT'den 3:1 (ya da 1:3) istenir ve konuyu, yüzleri ve yazıları kırpmadan
  sonra kalacak bantta tutması söylenir; ardından Backdraw görseli ortadan kırpar.
- İstenen orandan %1'den fazla sapan bir görsel ortadan kırpılır. Kırpılmış hali ana dosyadır
  (`<ad>.png`), ChatGPT'nin orijinali de yanında `<ad>_full.<uzantı>` olarak kalır. `output_dir`
  kopyalarına yalnızca ana dosya gider.
- ChatGPT başka bir biçimde çizdiyse ve kırpma planlanandan fazlasını kesmek zorunda kaldıysa, sonuç
  kesilmiş bir konu ya da yazı olup olmadığına bakmanı söyler.

### `transparent_background`

`transparent_background: true`, ChatGPT'den yalnızca konuyu gösteren, alfa kanallı bir PNG ister.
ChatGPT bunu her zaman yapmaz; bu yüzden Backdraw kaydedilen görseli kontrol eder: PNG başlığını
okur (alfa kanalı ya da `tRNS` bölümü) ve saydam piksellerin oranını ölçer. Sonuçta ya şu yazar:

```
Transparent background: yes — PNG with an alpha channel, 61% of the pixels are transparent.
```

ya da satır `⚠ TRANSPARENT BACKGROUND MISSING` ile başlar (alfa kanalı yok ya da piksellerin en fazla %2'si saydam).
Bu durumda yeni bir sohbette bir kez daha dene ya da arka planı başka bir araçla kaldır. Şeffaf
görsellerin önizlemeleri dama tahtası deseni üzerinde çizilir.

## Galeri yan paneli

Açılır pencerede **Galeriyi aç**'a tıkla; Backdraw'ın yan paneli bulunduğun sayfanın yanında açılır.
Araç çubuğundaki Backdraw simgesine sağ tıklayıp **Backdraw galerisini aç**'ı da seçebilirsin.

- **Üstte:** sürmekte olan iş (adım, iş numarası ve geçen süre; ChatGPT'nin mesajı için üzerine gel),
  "Boşta" ya da bağlı değil uyarısı.
- **Galeri:** ürettiğin görseller, en yenisi önce, 12'şer 12'şer (**Daha fazla yükle**). Her birinde
  küçük resim, tarih, istem (üzerine gelince ilk 300 karakteri görünür), boyut ve istendiyse en-boy
  oranı.
- **Her görsel için:** **Sohbeti aç**, **Klasörde göster** (Gezgin dosya seçili olarak açılır),
  **Yolu kopyala** ve **Koleksiyona ekle** (var olan bir koleksiyon ya da **Yeni koleksiyon…**).

Galeri, iş geçmişindeki görselleri listeler; geçmiş son 100 işi tutar. Küçük resimler 7 gün saklanan
önizlemelerden gelir; daha eski görsellerde yer tutucu görünür. Görsel dosyalarının kendisi görsel
klasöründe kalır.

## Araç başvurusu

| Araç | Parametreler (varsayılan) | Ne yapar |
|---|---|---|
| `generate_image` | `prompt` (zorunlu), `aspect_ratio`, `transparent_background` (false), `reference_images`, `reference_collection`, `reference_files`, `conversation_url`, `auto_reattach` (false), `send_as_is` (false), `output_dir`, `wait_seconds` (45), `include_preview` (true) | Projende yeni bir sohbet başlatır (ya da `conversation_url`'deki sohbete devam eder) ve görsel üretir veya düzenler. |
| `job_status` | `job_id`, `wait_seconds` (45), `include_preview` (true) | Bir işi bekler ve durumunu bildirir. `job_id` olmadan köprünün durumunu verir (Chrome bağlı mı, seçili Proje, görsel klasörü, kuyruk, son işler). |
| `cancel_job` | `job_id` (zorunlu) | Kuyruktaki ya da çalışan bir işi iptal eder. ChatGPT üretmeye başladıysa arka plan sekmesinde Durdur'a basar. |
| `fetch_images` | `conversation_url` (zorunlu), `aspect_ratio`, `output_dir`, `wait_seconds` (45), `include_preview` (true) | Var olan bir sohbetin son cevabındaki görselleri, hiçbir şey göndermeden indirir. |
| `list_projects` | – | ChatGPT Projelerini listeler ve seçili olanı gösterir. |
| `select_project` | `name` ya da `url` | Yeni görsel sohbetlerinin açılacağı Projeyi seçer ve hatırlar (ad esnek eşleştirilir). |
| `list_collections` | – | Referans koleksiyonlarını görsel sayıları, klasörleri ve dosyalarıyla (en yenisi önce) listeler. |

- `reference_images`: yerel png / jpg / webp / gif dosyaları, en fazla 16; koleksiyon görselleri
  kalan yerleri doldurur.
- `reference_files`: `list_collections`'taki dosya adları; `reference_collection`'dan yalnızca bu
  görselleri ekler.
- `conversation_url`: bir `https://chatgpt.com/` sohbet bağlantısı. Kısa ek istekler için uygundur;
  birebir düzenlemelerde `reference_images` ile yeni bir sohbet daha iyi sonuç verir.
- `auto_reattach`: ChatGPT görseli göremediğini söyleyip tekrar isterse görseli kendisi ekler ve bir
  kez daha sorar.
- `send_as_is`: istemi, Backdraw'ın eklediği kısa talimat olmadan, olduğu gibi gönderir (örneğin
  ChatGPT'nin sorduğu bir soruyu yanıtlamak için).
- `output_dir`: sonucu bu klasöre de kopyalar; görsel klasöründe her zaman bir kopya kalır.
- `wait_seconds`: 0 ile 900 arası.

Bir sonuç şunları söyleyebilir:

| Sonuç | Anlamı |
|---|---|
| `SUCCESS` | Kaydedilen dosya yol(lar)ı, sohbet bağlantısı ve bir önizleme. Düzenlemelerde bir **düzenleme kontrolü** (edit check) satırı da gelir. |
| `STILL RUNNING` / `QUEUED` | Henüz bitmedi; Claude iş numarasıyla `job_status`'u çağırmaya devam eder. |
| `NEEDS USER ACTION` | ChatGPT bir giriş ya da insan doğrulaması sayfası gösteriyor (bkz. [Sorun giderme](#sorun-giderme)). |
| `NEEDS REFERENCE IMAGE` | ChatGPT düzenlemesi gereken görsele erişemedi. Sonuç, o sohbetten daha önce kaydedilmiş görselleri listeler. |
| `CHATGPT REPLIED WITHOUT AN IMAGE` | ChatGPT metinle cevap verdi (bir soru, bir ret, bir limit); metnin ilk 3.000 karakteri sonuçtadır. |
| `FAILED` / `CANCELLED` | Nedeniyle ve varsa sohbet bağlantısıyla birlikte. |

## Hızlı dönüş

Görsel üretmek genellikle 1-3 dakika sürer, ama `generate_image`, `fetch_images` ve `job_status`
varsayılan olarak **45 saniye** içinde döner (`wait_seconds`). Görsel henüz hazır değilse sonuç
`STILL RUNNING` ya da `QUEUED` olur (kuyruk sırasıyla birlikte) ve bir iş numarası içerir; Claude iş
bitene kadar `job_status(job_id, wait_seconds=45)` çağırmaya devam eder.

Bilgisayarına buluttan bağlanan istemciler çoğu zaman bir araç çağrısından 60 saniye sonra vazgeçer;
45 saniyelik varsayılan bu çağrıları o sınırın altında tutar. İstemci ilerleme bilgisi isterse
Backdraw beklerken ilerleme bildirimleri gönderir. İstemcide bir araç çağrısını iptal etmek yalnızca
beklemeyi durdurur; iş, `cancel_job` onu durdurana kadar sürer.

## Komut satırı (CLI)

Kurulum ve sorun giderme için bunları Backdraw klasöründe çalıştır (`%USERPROFILE%\.backdraw` ya da
kurulumu yaptığın klasör). Her yerden `npx backdraw <komut>` aynı komutları çalıştırır, örneğin
`npx backdraw status`. `npm run status`, `node cli.js status` ile aynıdır.

```
node cli.js status                          Köprünün durumu (Chrome bağlı mı, seçili proje, kuyruk)
node cli.js projects                        ChatGPT projelerini listeler
node cli.js select <ad | bağlantı>          Görsellerin üretileceği projeyi seçer
node cli.js generate "<istem>" [--ref GÖRSEL]... [--url SOHBET_LİNKİ] [--aspect G:Y] [--transparent]
                     [--reattach] [--out KLASÖR] [--raw] [--wait 300] [--collection AD [--file DOSYA]...]
                                            Görsel üretir (--ref: referans ya da düzenlenecek görsel, en fazla 16)
node cli.js collect <sohbet linki> [--aspect G:Y] [--out KLASÖR]
                                            Var olan bir sohbetin son görsellerini indirir (bir şey göndermez)
node cli.js job <id> [--wait 60]            Bir işin durumunu gösterir
node cli.js cancel <id>                     Bir işi iptal eder
node cli.js collections                     Referans koleksiyonlarını listeler
node cli.js collection <ad>                 Bir koleksiyonu ve görsellerini gösterir
node cli.js outdir <klasör>                 Merkezi görsel klasörünü değiştirir
node cli.js debug on|off                    Ayrıntılı kayıt (logs\host.log)
node cli.js diagnose [link] [--selector CSS] [--max N] [--worker]
                                            Sayfa tanılama
node cli.js reload                          Chrome eklentisini yeniden yükler
```

Örnekler:

```
node cli.js generate "şafakta bir deniz feneri, suluboya" --aspect 16:9
node cli.js generate "sadece gözleri kapat" --ref C:\yol\portre.png
node cli.js collect https://chatgpt.com/c/<sohbet id> --aspect 16:9
```

## Doktor

```
npx backdraw@latest doctor          her şeyi kontrol eder, hiçbir şeyi değiştirmez
npx backdraw@latest doctor --fix    onarılması güvenli olanları onarır, sonra yeniden kontrol eder
```

`doctor` her kontrol için bir satır yazar: ✓ (sorun yok), ⚠ (bakmaya değer) ya da ✗ (bozuk); her
birinin yanında tek satırlık bir çözüm:

- Node.js sürümü, kurulum klasörü ve dosyalarının, eklentinin ve bu sürümün birbirini tutması.
- Host manifesti ve kurulu her tarayıcı için gerçekten okuduğu registry kaydı (Claude masaüstü
  uygulamasının MSIX korumalı alanının içinden de).
- Kullanıcı düzeyindeki native host'ları kapatan (`NativeMessagingUserLevelHosts`) ya da engelleyen
  (`NativeMessagingBlocklist`) tarayıcı politikaları. Bunları yalnızca bir yönetici değiştirebilir.
- Köprü (named pipe), eklenti ve sürümü, eklentinin en son gördüğü ChatGPT oturumu ve bir Proje
  seçili olup olmadığı.
- Her MCP istemcisinin Backdraw girdisi: var mı, bu kuruluma mı bakıyor. Claude masaüstü
  uygulamasının açık olup olmadığını da söyler.

`--fix` host manifestini ve registry kayıtlarını yeniden yazar, istemci girdilerini yeniden bu
kuruluma yönlendirir (yedek alarak; Claude masaüstü uygulamasınınkini yalnızca o kapalıyken).
Onaramadıklarını da söyler. Çıktı bir issue'ya yapıştırılabilir: kullanıcı klasörün `~` olarak
görünür; proje adları, istemler ve sohbet bağlantıları hiç yazılmaz.

## Sorun giderme

| Sorun | Ne yapmalı |
|---|---|
| Herhangi bir sorun | Önce `npx backdraw@latest doctor` çalıştır. |
| `BRIDGE NOT RUNNING` | Chrome kapalı ya da eklenti yüklü değil veya kapalı. Chrome'u aç (eklenti kendiliğinden bağlanır) ya da Backdraw'ı `chrome://extensions` sayfasından aç. `node cli.js status` ile kontrol et. |
| Backdraw simgesinde kırmızı **!** | Eklenti yerel host'a ulaşamıyor. Açılır pencere hatayı ve çözümünü gösterir. `npx backdraw@latest doctor --fix` (ya da yeniden `node install.js`) çalıştır, ardından Backdraw'ı `chrome://extensions` sayfasından yeniden yükle. |
| `NEEDS USER ACTION` | ChatGPT bir giriş ekranı ya da insan doğrulaması (CAPTCHA) gösteriyor. Chrome'da ChatGPT sekmesini açıp işlemi kendin tamamla; Backdraw bunu asla atlatmaya çalışmaz. İş seni 10 dakikaya kadar bekler; işlemi bitirdiğin anda kendiliğinden devam eder. 10 dakika dolarsa iş başarısız olur ve ChatGPT sekmesi açık kalır. |
| `⚠ EDIT CHECK (edited: false)` | ChatGPT düzenlemek yerine yeni bir resim çizdi (gerçek bir düzenleme görselin ~%95-100'ünü korur). Orijinali `reference_images` ile ve `conversation_url` olmadan, yani yeni bir sohbette tekrar iste. |
| `NEEDS REFERENCE IMAGE` | ChatGPT uzun bir sohbette görseli gözden kaçırdı. Görseli `reference_images` ile ekle (tercihen yeni bir sohbette) ya da `auto_reattach` kullan. |
| `FAILED — ChatGPT did not finish in time` | Bir iş yaklaşık 10 dakika sonra vazgeçer. Sonuçta bir sohbet bağlantısı varsa, ChatGPT işini bitirdiğinde `fetch_images` (ya da `node cli.js collect <link>`) görseli indirir; aynı şekilde kırpılması için aynı `aspect_ratio`'yu yeniden ver. |
| `No ChatGPT project is selected yet` | Açılır pencereden bir proje seç ya da Claude'dan Projelerini listeleyip seçmesini iste. |
| `ChatGPT did not open the project` | Proje silinmiş ya da yeniden adlandırılmış; yeniden seç. |
| İki Chrome profili | Yerel köprü her Windows kullanıcısı için tektir; Backdraw'ı yalnızca bir Chrome profilinde yükle. |

Ayrıntılı kayıt için `node cli.js debug on` çalıştır ve `%USERPROFILE%\.backdraw\logs\host.log`
dosyasına bak (sonra `node cli.js debug off` ile kapat).

### ChatGPT web arayüzü değişirse

Backdraw chatgpt.com web sayfasını yönetir; bu yüzden bir tasarım değişikliği onu bozabilir (örneğin
mesaj kutusunu artık bulamaz).

1. `node cli.js diagnose` (ya da `node cli.js diagnose <sohbet linki>`) çalıştır. Backdraw'ın
   gördüğü sayfa yapısının bir özetini yazar; `--selector CSS` ve `--max N` çıktıyı daraltır,
   `--worker` çalışan işin sekmesine bakar.
2. Seçiciler `extension/inpage.js` dosyasında.
3. Düzelttikten sonra `node install.js` komutunu yeniden çalıştır: dosyaları kopyalar ve çalışan
   eklentiyi yeniden yükler.
4. Neyin değiştiğini anlatan bir [issue aç](../../issues). Önce diagnose çıktısından kişisel
   bilgileri (sohbet başlıkları, proje adları, istemler) çıkar.

## Güncelleme

```
npx backdraw@latest setup
```

Elle kurulumda: `git pull` (ya da ZIP'i yeniden indirip aç), ardından `node install.js`.

İkisi de yeni dosyaları eskilerinin üzerine kopyalar, ayarlarını, iş geçmişini ve koleksiyonlarını
korur, her şeyi yeniden kaydeder ve çalışan eklentiyi yeniden yükler. Chrome kapalıysa yeni sürüm
Chrome açılınca yüklenir.

**"ChatGPT görsel köprüsü"nden (1.x) mi geliyorsun?** Setup (ya da `node install.js`) onu taşır: ayarları ve iş
geçmişini `%USERPROFILE%\.claude\chatgpt-image-bridge` klasöründen kopyalar (hiçbir şeyin üzerine
yazmadan), eski native host'u ve eski `chatgpt-images` MCP kaydını kaldırır. Ardından
`chrome://extensions` sayfasında eski "Claude ChatGPT Görsel Köprüsü" eklentisini kaldır ve yerine
`%USERPROFILE%\.backdraw\extension` klasörünü yükle; eklenti kimliği aynı kalır. Backdraw çalışınca
eski klasörü elle sil.

## Kaldırma

```
npx backdraw@latest uninstall --dry-run     neyin kaldırılacağını gösterir, hiçbir şeyi değiştirmez
npx backdraw@latest uninstall
```

(Elle kurulumda: `node install.js --uninstall [--dry-run]`.) Bu komut her tarayıcının native host
kaydını ve `backdraw` MCP kaydını Claude Code, Codex, Cursor, VS Code ve Gemini CLI'den, Claude
kapalıysa masaüstü uygulamasının ayarlarından da (her birinin yedeğini alarak) kaldırır; 1.x'in
kullandığı adları da temizler. Ardından eklentiyi `chrome://extensions` sayfasından kaldır.

Dosyaların korunur; iki yerde dururlar:

- `%USERPROFILE%\.backdraw`: programın kendisi, ayarların, iş geçmişi (istemlerle birlikte),
  önizlemeler ve kayıt dosyaları.
- Görsel klasörü, varsayılan olarak `Pictures\Backdraw`: ürettiğin görseller ve `References`
  altında referans koleksiyonların. Gerçekte kullanılan klasörleri deneme çalıştırması (dry run)
  listeler; kaldırmadan önce `node cli.js status` da gösterir.

Bunların da gitmesini istiyorsan bu klasörleri elle sil. 1.x'ten geldiysen
`%USERPROFILE%\.claude\chatgpt-image-bridge` klasörünü de sil.

## Gizlilik ve güvenlik

- Her şey senin bilgisayarında çalışır: Backdraw sunucusu yok, telemetri yok, API anahtarı yok.
- Backdraw cookie, token ya da şifre okumaz; giriş ekranlarını ve CAPTCHA'ları asla atlatmaz.
- Yerel köprü bir ağ portu değil, bir named pipe'tır; native host yalnızca Backdraw eklentisini
  kabul eder.
- İstemler, iş geçmişi, önizlemeler ve kayıt dosyaları `%USERPROFILE%\.backdraw` içinde kalır
  (`data\` ve `logs\`).
- `reference_images`, adı `.png`, `.jpg`, `.jpeg`, `.webp` ya da `.gif` ile biten herhangi bir yerel
  dosyayı bir ChatGPT mesajına ekleyebilir. Claude güvenmediğin içerikle çalışırken Backdraw'ın araç
  çağrılarını gözden geçir.

Ayrıntılar, tehdit modeli ve bir güvenlik açığını nasıl bildireceğin: [SECURITY.md](SECURITY.md).

## MCP protokol desteği

- **2026-07-28** (durumsuz): el sıkışma yok; her istek kendi sürümünü `_meta` içinde belirtir;
  `server/discover` desteklenir.
- **Eski `initialize` el sıkışması:** 2025-11-25, 2025-06-18, 2025-03-26 ve 2024-11-05.
- Araç başlıkları ve ipuçları (annotations), ilerleme bildirimleri, `notifications/cancelled` ve
  JSON-RPC toplu istekleri. Desteklenmeyen bir sürüm, desteklenenlerin listesiyle birlikte `-32022`
  hatası alır.

## Sorumluluk reddi ve sorumlu kullanım

- **Kişisel kullanım, kendi hesabın.** Backdraw, kendi Chrome'unda kendi ChatGPT hesabıyla görsel
  üreten tek bir kişi için yapıldı. Bir hesabı paylaşmak, başkalarına hizmet olarak görsel üretmek
  ya da bir ürünün arka ucu olarak kullanmak için kullanma.
- **OpenAI'ın koşulları.** OpenAI'ın [Kullanım Koşulları](https://openai.com/policies/row-terms-of-use/),
  verinin ya da çıktının otomatik veya programlı olarak çıkarılmasını ("automatically or
  programmatically extract data or Output") ve hız sınırlarının ya da koruma önlemlerinin
  aşılmasını yasaklar. Backdraw ChatGPT web sayfasını senin yerine kullandığı için bu koşullarla
  çelişebilir. Koşulları oku ve kararını kendin ver.
- **Hesabınla ilgili risk sana aittir.** OpenAI, koşullarını ihlal ettiğini düşündüğü bir hesabı
  sınırlayabilir, askıya alabilir ya da kapatabilir. Backdraw hiçbir garanti olmadan sunulur
  ([MIT lisansı](LICENSE)); geliştiricileri hesabına olacaklardan sorumlu değildir.
- **Aynı anda tek iş, insan temposunda.** Tek bir kuyruk var: bir arka plan sekmesinde bir istem;
  sıradaki iş ancak görsel kaydedildikten sonra başlar. Backdraw paralel sohbet açmaz, istemleri
  kendiliğinden yeniden göndermez (`auto_reattach`'in tek seferlik yeniden sorması dışında) ve her
  giriş ya da insan doğrulaması sayfasında, sen bitirene kadar bekler.
- **Normal limitlerin geçerli.** Her görsel, kendi ChatGPT kullanım limitlerinden düşer.
- OpenAI ya da Anthropic ile bir bağlantısı yoktur; onlar tarafından onaylanmamış ya da
  desteklenmemiştir.

## Lisans

[MIT](LICENSE)
