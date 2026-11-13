'use strict';
/**
 * Firestore security rules have two size ceilings, and neither is checked
 * before a deploy: the emulator loads an oversized ruleset and the Firebase
 * CLI carries no limit. The first signal is a failed release.
 *
 *   SOURCE_CAP    the rules source text, comments included: 256 KiB.
 *   COMPILED_CAP  the compiled ruleset: 256,000 bytes. Firebase reports it as
 *                 "Total size of compiled executables must be smaller than
 *                 256000 bytes (actual: N bytes)".
 *
 * The compiled size cannot be computed locally, so it is estimated from the
 * source with comments removed, times a ratio. See DEFAULT_RATIO.
 */

const SOURCE_CAP = 256 * 1024;
const COMPILED_CAP = 256000;

/**
 * Compiled bytes per byte of comment-free source, when you have not measured
 * your own. A starting assumption, not a property of Firestore: a ruleset
 * that compiles denser or sparser will differ. Replace it with your own
 * figure as soon as Firebase gives you one (see calibrate()).
 */
const DEFAULT_RATIO = 1.4;

const DEFAULT_WARN_AT = 0.85;
const DEFAULT_FAIL_AT = 0.95;

const bytes = (s) => Buffer.byteLength(s, 'utf8');

/**
 * Remove comments from rules source: line comments, block comments, and the
 * whitespace and blank lines they leave behind. Quoted strings are read as
 * strings, so a "//" or "/*" inside one is kept.
 *
 * Indentation and every other byte of code are left as they are, so the
 * result is still a valid ruleset and can be deployed.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      j = Math.min(j + 1, n);
      out += src.slice(i, j);
      i = j;
    } else if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i += 1;
      out = out.replace(/[ \t]+$/, '');
    } else if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += c;
      i += 1;
    }
  }
  return out
    .replace(/[ \t]+$/gm, '')
    .replace(/\n\s*\n/g, '\n')
    .replace(/^\s*\n/, '');
}

/** The sizes of a ruleset, measured and estimated. */
function measure(src, options = {}) {
  const ratio = options.ratio === undefined ? DEFAULT_RATIO : options.ratio;
  if (!(ratio > 0) || !Number.isFinite(ratio)) throw new RangeError('ratio must be a positive number');
  const sourceBytes = bytes(src);
  const codeBytes = bytes(stripComments(src));
  const compiledBytes = Math.round(codeBytes * ratio);
  return {
    sourceBytes,
    codeBytes,
    commentBytes: sourceBytes - codeBytes,
    compiledBytes,
    ratio,
    sourceShare: sourceBytes / SOURCE_CAP,
    compiledShare: compiledBytes / COMPILED_CAP,
  };
}

/**
 * Judge a ruleset against both ceilings.
 *
 *   failAt        share of a ceiling at which the check fails (default 0.95)
 *   warnAt        share at which it warns (default 0.85)
 *   ratio         compiled bytes per code byte (default DEFAULT_RATIO)
 *   ignoreSource  set when the file is deployed with comments stripped, so
 *                 only the comment-free size can reach the source ceiling
 */
function check(src, options = {}) {
  const failAt = options.failAt === undefined ? DEFAULT_FAIL_AT : options.failAt;
  const warnAt = options.warnAt === undefined ? DEFAULT_WARN_AT : options.warnAt;
  for (const [name, v] of [['failAt', failAt], ['warnAt', warnAt]]) {
    if (!(v > 0 && v <= 1)) throw new RangeError(`${name} must be above 0 and at most 1`);
  }
  const m = measure(src, options);
  // What can reach the source ceiling: the file as it is, or its code alone
  // when the deploy strips comments first.
  const deployedSourceBytes = options.ignoreSource ? m.codeBytes : m.sourceBytes;
  const lines = [
    { key: 'source', label: options.ignoreSource ? 'source, comments stripped' : 'source text', bytes: deployedSourceBytes, cap: SOURCE_CAP },
    { key: 'compiled', label: 'compiled (estimated)', bytes: m.compiledBytes, cap: COMPILED_CAP },
  ].map((l) => {
    const share = l.bytes / l.cap;
    return { ...l, share, status: share >= failAt ? 'fail' : share >= warnAt ? 'warn' : 'ok' };
  });
  const status = lines.some((l) => l.status === 'fail') ? 'fail' : lines.some((l) => l.status === 'warn') ? 'warn' : 'ok';
  return { ...m, failAt, warnAt, lines, status };
}

/**
 * The ratio for your ruleset, from a compiled size Firebase reported for it.
 * Pass the source that was deployed and the "actual: N bytes" figure.
 */
function calibrate(src, actualCompiledBytes) {
  const codeBytes = bytes(stripComments(src));
  if (!(actualCompiledBytes > 0) || codeBytes === 0) throw new RangeError('need a non-empty ruleset and a positive compiled size');
  return actualCompiledBytes / codeBytes;
}

module.exports = {
  SOURCE_CAP, COMPILED_CAP, DEFAULT_RATIO, DEFAULT_WARN_AT, DEFAULT_FAIL_AT,
  stripComments, measure, check, calibrate,
};
