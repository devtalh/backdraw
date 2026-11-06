// UI texts of the extension pages, the in-page note, the right-click menu and the service worker, by
// key: English or Turkish, as picked in the popup (chrome.storage.local "language": 'auto' | 'en' |
// 'tr'; 'auto' follows the browser's language). A key without a Turkish text falls back to English,
// then to the key itself. _locales/ only holds the manifest's description.
(() => {
  const STRINGS = {
    en: {
      bridge: 'Bridge',
      project: 'Project',
      job: 'Job',
      connected: 'Connected',
      notConnected: 'Not connected',
      noHost: 'The local bridge was not found{error}. Make sure the setup script (install.js) has been run.',
      notSelected: 'Not selected',
      idle: 'Idle',
      useProject: 'Use the “{name}” project',
      selectFailed: 'Could not select it.',
      version: 'Version',
      footerNote: 'Images are made in a background tab; your active tab does not change.',
      collections: 'Collections',
      noCollections: 'No collections yet. Right-click an image on any page and choose "Add to Backdraw".',
      imageCountOne: '1 image',
      imageCount: '{count} images',
      back: '‹ Back',
      rename: 'Rename',
      save: 'Save',
      cancel: 'Cancel',
      deleteCollection: 'Delete collection',
      confirmDelete: 'Delete "{name}" and its {images} from disk?',
      delete: 'Delete',
      removeImage: 'Delete this image',
      confirmRemoveImage: 'Click again to delete',
      loading: 'Loading…',
      noThumb: 'no preview',
      leftover: 'Not everything could be deleted. Left in the folder: {files}',
      newTitle: 'New collection',
      nameLabel: 'Collection name',
      namePlaceholder: 'e.g. Character references',
      nameExists: 'A collection with this name exists; the image is added to it.',
      nameInvalid: 'Use 1 to 64 characters.',
      add: 'Add',
      preparing: 'Preparing the image…',
      saving: 'Saving…',
      toastAdding: 'Adding to {name}…',
      toastAdded: 'Added to {name} · {images}',
      toastDuplicate: 'Already in {name} · {images}',
      errNotConnected: 'Backdraw is not connected. Is it installed (node install.js)?',
      errNotImage: 'This is not an image Backdraw can save.',
      errTooLarge: 'The image is larger than {mb} MB.',
      errDownload: 'The image could not be downloaded ({reason}).',
      errNoSource: 'Chrome did not pass on this image\'s address (it does not for very large embedded images), so it cannot be added.',
      errExpired: 'This window has expired; right-click the image again.',
      errTimeout: 'Backdraw did not answer in time.',
      menuAdd: 'Add to Backdraw',
      menuNew: 'New collection…',
      menuOffline: 'Backdraw is not connected',
      settings: 'Settings',
      language: 'Language',
      theme: 'Theme',
      optAuto: 'Auto',
      langEnglish: 'English',
      langTurkish: 'Türkçe',
      themeLight: 'Light',
      themeDark: 'Dark',
      setupTitle: 'Set up Backdraw',
      setupChecklist: 'Setup',
      setupCount: '{done} of {total} done',
      stepBridge: 'Local bridge connected',
      bridgeOk: 'Chrome is talking to Backdraw on this computer.',
      bridgeMissing: 'Chrome cannot reach the Backdraw bridge.',
      chromeSays: 'Chrome says: {error}',
      bridgeFix: 'Run this in the Backdraw folder, then reopen this popup:',
      bridgeReload: 'If you just installed: chrome://extensions → Backdraw → Reload.',
      retry: 'Try again',
      copy: 'Copy',
      copied: 'Copied',
      stepChatgpt: 'Signed in to ChatGPT',
      chatgptIn: 'You are signed in to ChatGPT in Chrome.',
      chatgptOut: 'You are not signed in to ChatGPT in Chrome.',
      chatgptChallenge: 'ChatGPT is showing a human verification page. Open ChatGPT and complete it.',
      chatgptUnknown: 'Not checked yet. The check opens chatgpt.com in a background tab for a moment.',
      chatgptChecking: 'Checking in a background tab…',
      openChatgptSignIn: 'Open ChatGPT to sign in',
      openChatgpt: 'Open ChatGPT',
      checkNow: 'Check now',
      checkAgain: 'Check again',
      errChatgptCheck: 'ChatGPT did not finish loading; try again.',
      stepProject: 'Project selected',
      projectUsing: 'Images go to the “{name}” project.',
      projectGuide: 'In ChatGPT, create a Project for your images (e.g. "Backdraw") and open it. Then click the Backdraw icon again: a "Use the … project" button appears here.',
      projectNeedsBridge: 'Needs the bridge (step 1) first.',
      chooseProject: 'Choose from my projects',
      loadingProjects: 'Reading your projects in a background tab…',
      noProjects: 'No projects were found in ChatGPT.',
      stepReady: 'Ready',
      readyIntro: 'Ask Claude, for example:',
      examplePrompt: 'Generate an image with ChatGPT: a cozy reading nook, 16:9',
      readyCollections: 'Collect references: right-click any image → "Add to Backdraw".',
      readyWaiting: 'Finish the steps above first.',
      gotIt: 'Done',
      chatgpt: 'ChatGPT',
      signedIn: 'Signed in',
      signedOut: 'Not signed in',
      notChecked: 'Not checked',
      verification: 'Verification needed',
      openGallery: 'Open gallery',
      jobPercent: '{step} ({pct}%)',
      jobStarting: 'Starting',
      jobOpening: 'Opening ChatGPT',
      jobAttaching: 'Attaching the reference images',
      jobTyping: 'Writing the prompt',
      jobSending: 'Sending the prompt',
      jobGenerating: 'ChatGPT is generating the image',
      jobReattaching: 'Attaching the image again',
      jobAnimating: 'Asking ChatGPT again for an animated GIF',
      jobVerifying: 'Checking the final version',
      jobDownloading: 'Downloading the image',
      jobNeedsHuman: 'Waiting for you in the ChatGPT tab (sign-in or verification)',
      jobResuming: 'Continuing',
      galleryTitle: 'Gallery',
      refresh: 'Refresh',
      loadMore: 'Load more',
      galleryEmpty: 'No images yet. Images Claude makes with Backdraw show up here.',
      galleryFetched: 'Fetched from a ChatGPT chat',
      elapsed: '{time} elapsed',
      openChat: 'Open chat',
      noChatLink: 'No chat link',
      showInFolder: 'Show in folder',
      copyPath: 'Copy path',
      pathCopied: 'Path copied',
      copyFailed: 'Could not copy the path.',
      addToCollection: 'Add to collection',
      newCollectionItem: 'New collection…',
      fileMissing: 'The file was moved or deleted.',
      stepQueued: 'Waiting for its turn',
      stepStarting: 'Starting',
      stepOpening: 'Opening ChatGPT',
      stepAttaching: 'Attaching reference images',
      stepTyping: 'Writing the prompt',
      stepSending: 'Sending the prompt',
      stepGenerating: 'ChatGPT is generating',
      stepVerifying: 'Checking the final image',
      stepDownloading: 'Downloading the image',
      stepReattaching: 'Attaching the image again',
      stepAnimating: 'Asking ChatGPT again for an animated GIF',
      stepNeedsHuman: 'Waiting for you: open the ChatGPT tab in Chrome and finish the login or verification',
      stepResuming: 'Continuing',
      menuGallery: 'Open Backdraw gallery',
    },
    tr: {
      bridge: 'Köprü',
      project: 'Proje',
      job: 'İş',
      connected: 'Bağlı',
      notConnected: 'Bağlı değil',
      noHost: 'Yerel köprü bulunamadı{error}. Kurulum betiğini (install.js) çalıştırdığından emin ol.',
      notSelected: 'Seçilmedi',
      idle: 'Boşta',
      useProject: '“{name}” projesini kullan',
      selectFailed: 'Seçilemedi.',
      version: 'Sürüm',
      footerNote: 'Görseller arka planda üretilir; aktif sekmen değişmez.',
      collections: 'Koleksiyonlar',
      noCollections: 'Henüz koleksiyon yok. Herhangi bir sayfada bir görsele sağ tıklayıp "Backdraw\'a ekle"yi seç.',
      imageCountOne: '1 görsel',
      imageCount: '{count} görsel',
      back: '‹ Geri',
      rename: 'Yeniden adlandır',
      save: 'Kaydet',
      cancel: 'Vazgeç',
      deleteCollection: 'Koleksiyonu sil',
      confirmDelete: '"{name}" ve içindeki {images} diskten silinsin mi?',
      delete: 'Sil',
      removeImage: 'Bu görseli sil',
      confirmRemoveImage: 'Silmek için tekrar tıkla',
      loading: 'Yükleniyor…',
      noThumb: 'önizleme yok',
      leftover: 'Her şey silinemedi. Klasörde kalanlar: {files}',
      newTitle: 'Yeni koleksiyon',
      nameLabel: 'Koleksiyon adı',
      namePlaceholder: 'örn. Karakter referansları',
      nameExists: 'Bu adda bir koleksiyon var; görsel ona eklenir.',
      nameInvalid: '1 ile 64 karakter arasında bir ad yaz.',
      add: 'Ekle',
      preparing: 'Görsel hazırlanıyor…',
      saving: 'Kaydediliyor…',
      toastAdding: '{name} koleksiyonuna ekleniyor…',
      toastAdded: '{name} koleksiyonuna eklendi · {images}',
      toastDuplicate: 'Zaten {name} içinde · {images}',
      errNotConnected: 'Backdraw bağlı değil. Kurulu mu (node install.js)?',
      errNotImage: 'Bu, Backdraw\'ın kaydedebileceği bir görsel değil.',
      errTooLarge: 'Görsel {mb} MB\'tan büyük.',
      errDownload: 'Görsel indirilemedi ({reason}).',
      errNoSource: 'Chrome bu görselin adresini iletmedi (çok büyük gömülü görsellerde iletmiyor), bu yüzden eklenemiyor.',
      errExpired: 'Bu pencerenin süresi doldu; görsele yeniden sağ tıkla.',
      errTimeout: 'Backdraw zamanında yanıt vermedi.',
      menuAdd: 'Backdraw\'a ekle',
      menuNew: 'Yeni koleksiyon…',
      menuOffline: 'Backdraw bağlı değil',
      settings: 'Ayarlar',
      language: 'Dil',
      theme: 'Tema',
      optAuto: 'Otomatik',
      langEnglish: 'English',
      langTurkish: 'Türkçe',
      themeLight: 'Açık',
      themeDark: 'Koyu',
      setupTitle: 'Backdraw kurulumu',
      setupChecklist: 'Kurulum',
      setupCount: '{done}/{total} tamam',
      stepBridge: 'Yerel köprü bağlı',
      bridgeOk: 'Chrome bu bilgisayardaki Backdraw ile konuşuyor.',
      bridgeMissing: 'Chrome, Backdraw köprüsüne ulaşamıyor.',
      chromeSays: 'Chrome\'un mesajı: {error}',
      bridgeFix: 'Backdraw klasöründe bunu çalıştır, sonra bu pencereyi yeniden aç:',
      bridgeReload: 'Yeni kurduysan: chrome://extensions → Backdraw → Yeniden yükle.',
      retry: 'Tekrar dene',
      copy: 'Kopyala',
      copied: 'Kopyalandı',
      stepChatgpt: 'ChatGPT oturumu açık',
      chatgptIn: 'Chrome\'da ChatGPT oturumu açık.',
      chatgptOut: 'Chrome\'da ChatGPT oturumu açık değil.',
      chatgptChallenge: 'ChatGPT bir insan doğrulaması gösteriyor. ChatGPT\'yi açıp doğrulamayı tamamla.',
      chatgptUnknown: 'Henüz kontrol edilmedi. Kontrol, chatgpt.com\'u kısa bir süre arka planda bir sekmede açar.',
      chatgptChecking: 'Arka planda bir sekmede kontrol ediliyor…',
      openChatgptSignIn: 'Oturum açmak için ChatGPT\'yi aç',
      openChatgpt: 'ChatGPT\'yi aç',
      checkNow: 'Şimdi kontrol et',
      checkAgain: 'Tekrar kontrol et',
      errChatgptCheck: 'ChatGPT yüklenmeyi bitirmedi; tekrar dene.',
      stepProject: 'Proje seçili',
      projectUsing: 'Görseller “{name}” projesine gidiyor.',
      projectGuide: 'ChatGPT\'de görsellerin için bir Proje oluştur (ör. "Backdraw") ve onu aç. Sonra Backdraw simgesine yeniden tıkla: burada "… projesini kullan" düğmesi çıkar.',
      projectNeedsBridge: 'Önce köprü gerekli (1. adım).',
      chooseProject: 'Projelerimden seç',
      loadingProjects: 'Projelerin arka planda bir sekmede okunuyor…',
      noProjects: 'ChatGPT\'de proje bulunamadı.',
      stepReady: 'Hazır',
      readyIntro: 'Claude\'a örneğin şunu yaz:',
      examplePrompt: 'ChatGPT ile bir görsel üret: sıcacık bir okuma köşesi, 16:9',
      readyCollections: 'Referans topla: herhangi bir görsele sağ tıkla → "Backdraw\'a ekle".',
      readyWaiting: 'Önce yukarıdaki adımları bitir.',
      gotIt: 'Tamam',
      chatgpt: 'ChatGPT',
      signedIn: 'Oturum açık',
      signedOut: 'Oturum kapalı',
      notChecked: 'Kontrol edilmedi',
      verification: 'Doğrulama gerekli',
      openGallery: 'Galeriyi aç',
      jobPercent: '{step} (%{pct})',
      jobStarting: 'Başlıyor',
      jobOpening: 'ChatGPT açılıyor',
      jobAttaching: 'Referans görseller ekleniyor',
      jobTyping: 'İstem yazılıyor',
      jobSending: 'İstem gönderiliyor',
      jobGenerating: 'ChatGPT görseli üretiyor',
      jobReattaching: 'Görsel yeniden ekleniyor',
      jobAnimating: 'ChatGPT\'den yeniden animasyonlu GIF isteniyor',
      jobVerifying: 'Son hâli kontrol ediliyor',
      jobDownloading: 'Görsel indiriliyor',
      jobNeedsHuman: 'ChatGPT sekmesinde seni bekliyor (oturum açma ya da doğrulama)',
      jobResuming: 'Devam ediyor',
      galleryTitle: 'Galeri',
      refresh: 'Yenile',
      loadMore: 'Daha fazla yükle',
      galleryEmpty: 'Henüz görsel yok. Claude\'un Backdraw ile ürettiği görseller burada görünür.',
      galleryFetched: 'Bir ChatGPT sohbetinden alındı',
      elapsed: '{time} geçti',
      openChat: 'Sohbeti aç',
      noChatLink: 'Sohbet bağlantısı yok',
      showInFolder: 'Klasörde göster',
      copyPath: 'Yolu kopyala',
      pathCopied: 'Yol kopyalandı',
      copyFailed: 'Yol kopyalanamadı.',
      addToCollection: 'Koleksiyona ekle',
      newCollectionItem: 'Yeni koleksiyon…',
      fileMissing: 'Dosya taşınmış ya da silinmiş.',
      stepQueued: 'Sırasını bekliyor',
      stepStarting: 'Başlıyor',
      stepOpening: 'ChatGPT açılıyor',
      stepAttaching: 'Referans görseller ekleniyor',
      stepTyping: 'İstem yazılıyor',
      stepSending: 'İstem gönderiliyor',
      stepGenerating: 'ChatGPT üretiyor',
      stepVerifying: 'Son görsel kontrol ediliyor',
      stepDownloading: 'Görsel indiriliyor',
      stepReattaching: 'Görsel yeniden ekleniyor',
      stepAnimating: 'ChatGPT\'den yeniden animasyonlu GIF isteniyor',
      stepNeedsHuman: 'Seni bekliyor: Chrome\'da ChatGPT sekmesini açıp girişi ya da doğrulamayı tamamla',
      stepResuming: 'Devam ediliyor',
      menuGallery: 'Backdraw galerisini aç',
    },
  };

  const PREFERENCES = ['auto', 'en', 'tr'];
  const LANGUAGE_KEY = 'language'; // in chrome.storage.local
  let preference = 'auto';

  // The language a preference means; 'auto' takes Turkish for a Turkish browser, else English.
  function resolve(pref, uiLanguage) {
    if (pref === 'en' || pref === 'tr') return pref;
    return /^tr\b/i.test(String(uiLanguage || '')) ? 'tr' : 'en';
  }

  // Chrome's own UI language, as _locales uses; navigator.language follows the websites' language list.
  function uiLanguage() {
    try { return chrome.i18n.getUILanguage(); } catch {}
    try { return navigator.language; } catch { return ''; }
  }

  const lang = () => resolve(preference, uiLanguage());

  function setPreference(pref) {
    preference = PREFERENCES.includes(pref) ? pref : 'auto';
    return lang();
  }

  // Reads the user's choice; pages and the worker call it once before they show texts.
  async function load() {
    try { setPreference((await chrome.storage.local.get(LANGUAGE_KEY))[LANGUAGE_KEY]); } catch {}
    return lang();
  }

  // onChange(lang) runs whenever the choice changes (in the popup, maybe in another window).
  function watch(onChange) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[LANGUAGE_KEY]) return;
        setPreference(changes[LANGUAGE_KEY].newValue);
        onChange(lang());
      });
    } catch {}
  }

  // A path or message as the extension shows it: the user's home folder (it holds their name) becomes
  // "~". home comes from the host; without it, user folders are recognised by their usual shape.
  function shortPath(text, home) {
    const s = String(text ?? '');
    const h = String(home || '').replace(/[\\/]+$/, '');
    if (h) return s.replace(new RegExp(`${h.replace(/[.*+?^$()|[\]{}\\]/g, '\\$&')}(?!\\w)`, 'gi'), '~');
    return s.replace(/(^|[\s"'(])[A-Za-z]:\\Users\\[^\\/"'\r\n]+/g, '$1~').replace(/(^|[\s"'(])\/(?:Users|home)\/[^/\s"']+/g, '$1~');
  }

  // {name} placeholders are filled from vars; an unknown key shows as itself.
  function translate(language, key, vars) {
    const s = (STRINGS[language] && STRINGS[language][key]) || STRINGS.en[key] || key;
    return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : s;
  }

  const t = (key, vars) => translate(lang(), key, vars);
  const images = n => t(n === 1 ? 'imageCountOne' : 'imageCount', { count: n });

  // A page names its texts with data-i18n (text), data-i18n-title and data-i18n-placeholder.
  function apply(root = document) {
    for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
    for (const el of root.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle);
    for (const el of root.querySelectorAll('[data-i18n-placeholder]')) el.placeholder = t(el.dataset.i18nPlaceholder);
  }

  const api = { STRINGS, PREFERENCES, LANGUAGE_KEY, lang, resolve, setPreference, load, watch, translate, t, images, apply, shortPath };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else globalThis.i18n = api;
})();
