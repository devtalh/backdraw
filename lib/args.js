'use strict';
// Argument helpers for the MCP tools and the CLI.

// A whole number within lo..hi. Only a number or a numeric string counts: anything else (missing,
// null, '', a boolean) gets the default, so a client that sends null for an omitted wait still waits.
function intArg(v, lo, hi, dflt) {
  const n = typeof v === 'number' || (typeof v === 'string' && v.trim()) ? Number(v) : NaN;
  return Math.min(hi, Math.max(lo, Number.isFinite(n) ? Math.round(n) : dflt));
}

// Positionals plus --flags. A flag in `booleans` never takes a value, so it can't swallow the next
// word; any other flag takes the next word unless that is another flag (or missing: then it is true).
// Flags in `lists` collect every value (--ref a --ref b); for the others the last one wins.
// --flag=value works too.
function parseArgs(argv, { booleans = [], lists = [] } = {}) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const key = eq > 2 ? a.slice(2, eq) : a.slice(2);
    const value = eq > 2 ? a.slice(eq + 1)
      : !booleans.includes(key) && i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    flags[key] = lists.includes(key) && key in flags ? [].concat(flags[key], value) : value;
  }
  return { pos, flags };
}

module.exports = { intArg, parseArgs };
