// Pure text helpers shared by the popup and its tests. All wording comes from i18n.
(() => {
  const REASONS = ['failed', 'timeout', 'text_reply', 'needs_reference', 'cancelled', 'no_images', 'active', 'not_created', 'other'];

  function keptSummary(kept, keptTotal, t, done = false) {
    if (!keptTotal) return '';
    const list = REASONS.filter(code => kept?.[code] > 0).map(code => {
      const n = kept[code];
      return `${n} ${t(`reason_${code}_${n === 1 ? 'one' : 'other'}`)}`;
    }).join(', ');
    return t(`cleanupKept${done ? 'Done' : 'Preview'}${keptTotal === 1 ? '_one' : ''}`, { n: keptTotal, list });
  }

  // N chats can be archived; M can be deleted, K of those already archived.
  function previewText(preview, t) {
    const n = preview?.eligible?.length || 0, m = preview?.deletable?.length || 0;
    const k = (preview?.deletable || []).filter(chat => chat.archived).length;
    const one = count => (count === 1 ? '_one' : '');
    const parts = [];
    if (n) parts.push(t('cleanupArchivable' + one(n), { n }));
    if (m) parts.push(k ? t('cleanupDeletableArchived' + one(m), { n: m, k }) : t('cleanupDeletable' + one(m), { n: m }));
    return parts.length ? parts.join(' ') : t('cleanupEmpty');
  }

  function progressText(progress, t) {
    const p = progress || {};
    const text = t(p.action === 'delete' ? 'cleanupDeleting' : 'cleanupArchiving', { done: p.done || 0, total: p.total || 0 });
    return text + (p.failed > 0 ? t('cleanupProgressFailed', { n: p.failed }) : '');
  }

  function finishText(progress, t) {
    const p = progress || {};
    const keys = { archived: 'cleanupArchived', alreadyArchived: 'cleanupAlreadyArchived', deleted: 'cleanupDeleted', gone: 'cleanupGone', skipped: 'cleanupSkipped', failed: 'cleanupFailed', notProcessed: 'cleanupNotProcessed' };
    const list = Object.entries(keys).filter(([field]) => p[field] > 0).map(([field, key]) =>
      t(key + (p[field] === 1 ? '_one' : ''), { n: p[field] })).join(', ');
    return list ? t('cleanupFinished', { list }) : t('cleanupUnchanged');
  }

  function errorText(code, t) {
    const keys = { unsupported_language: 'cleanupErrLanguage', login: 'cleanupErrLogin', challenge: 'cleanupErrLogin',
      too_many_failures: 'cleanupErrFailures', tab_closed: 'cleanupErrTab', not_connected: 'errNotConnected' };
    return t(Object.hasOwn(keys, code) ? keys[code] : 'cleanupErrUnknown');
  }

  const STEP_KEYS = { load: 'cleanupStep_load', language: 'cleanupStep_language', open_menu: 'cleanupStep_open_menu',
    menu_items: 'cleanupStep_menu_items', click_item: 'cleanupStep_click_item', delete_dialog: 'cleanupStep_delete_dialog',
    confirm_delete: 'cleanupStep_confirm_delete', verify: 'cleanupStep_verify' };

  // "Stopped at: <step> (<code>)" for the failure that ended a cleanup; empty when no step is known.
  function stopText(progress, t) {
    const stop = progress?.stop;
    if (!progress?.error || !stop || typeof stop !== 'object') return '';
    const stepKey = Object.hasOwn(STEP_KEYS, stop.step) ? STEP_KEYS[stop.step] : 'cleanupStep_unknown';
    const code = /^[a-z_]{1,40}$/.test(String(stop.code)) ? stop.code : 'unknown';
    return t('cleanupStoppedAt', { step: t(stepKey), code });
  }

  globalThis.backdrawCleanupText = { keptSummary, previewText, progressText, finishText, errorText, stopText };
})();
