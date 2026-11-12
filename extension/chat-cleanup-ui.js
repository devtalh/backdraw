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

  function progressText(progress, t) {
    const p = progress || {};
    const text = t(p.action === 'delete' ? 'cleanupDeleting' : 'cleanupArchiving', { done: p.done || 0, total: p.total || 0 });
    return text + (p.failed > 0 ? t('cleanupProgressFailed', { n: p.failed }) : '');
  }

  function finishText(progress, t) {
    const p = progress || {};
    const keys = { archived: 'cleanupArchived', alreadyArchived: 'cleanupAlreadyArchived', deleted: 'cleanupDeleted', skipped: 'cleanupSkipped', failed: 'cleanupFailed', notProcessed: 'cleanupNotProcessed' };
    const list = Object.entries(keys).filter(([field]) => p[field] > 0).map(([field, key]) =>
      t(key + (p[field] === 1 ? '_one' : ''), { n: p[field] })).join(', ');
    return list ? t('cleanupFinished', { list }) : t('cleanupUnchanged');
  }

  function errorText(code, t) {
    const keys = { unsupported_language: 'cleanupErrLanguage', login: 'cleanupErrLogin', challenge: 'cleanupErrLogin',
      too_many_failures: 'cleanupErrFailures', tab_closed: 'cleanupErrTab', not_connected: 'errNotConnected' };
    return t(Object.hasOwn(keys, code) ? keys[code] : 'cleanupErrUnknown');
  }

  globalThis.backdrawCleanupText = { keptSummary, progressText, finishText, errorText };
})();
