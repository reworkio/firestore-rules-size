#!/usr/bin/env node
'use strict';
const fs = require('fs');
const lib = require('../lib');

const HELP = `firestore-rules-size: how close a Firestore ruleset is to its size ceilings

Usage
  firestore-rules-size [check] [file] [options]   judge the file (default: firestore.rules)
  firestore-rules-size strip [file] [-o out]      print the file with comments removed
  firestore-rules-size calibrate [file] --actual N
                                                  the compiled ratio for your ruleset, from
                                                  the "actual: N bytes" Firebase reported

Options for check
  --fail-at <0-1>     share of a ceiling that fails the check (default ${lib.DEFAULT_FAIL_AT})
  --warn-at <0-1>     share that prints a warning (default ${lib.DEFAULT_WARN_AT})
  --ratio <n>         compiled bytes per byte of comment-free source
                      (default ${lib.DEFAULT_RATIO}, an assumption; use your own, see calibrate)
  --ignore-source     the deploy strips comments, so judge the source ceiling
                      on the comment-free size
  --json              print the result as JSON

Exit status: 0 ok or warning, 1 past --fail-at, 2 bad usage or unreadable file.
`;

function fail(message) {
  process.stderr.write(`firestore-rules-size: ${message}\n`);
  process.exit(2);
}

function parse(argv) {
  const out = { _: [] };
  const valued = { '--fail-at': 'failAt', '--warn-at': 'warnAt', '--ratio': 'ratio', '--actual': 'actual', '-o': 'out', '--out': 'out' };
  const flags = { '--ignore-source': 'ignoreSource', '--json': 'json', '--help': 'help', '-h': 'help' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (valued[a]) {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      out[valued[a]] = argv[i += 1];
    } else if (flags[a]) out[flags[a]] = true;
    else if (a.startsWith('-')) fail(`unknown option ${a}`);
    else out._.push(a);
  }
  return out;
}

function number(value, name) {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) fail(`${name} must be a number, got "${value}"`);
  return n;
}

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (err) {
    return fail(err.code === 'ENOENT' ? `${file} not found` : `cannot read ${file}: ${err.message}`);
  }
}

const fmt = (n) => n.toLocaleString('en-US');
const pct = (share) => `${(100 * share).toFixed(1)}%`;

function main() {
  const args = parse(process.argv.slice(2));
  if (args.help) { process.stdout.write(HELP); return 0; }
  const commands = ['check', 'strip', 'calibrate'];
  const command = commands.includes(args._[0]) ? args._.shift() : 'check';
  if (args._.length > 1) fail(`one file at a time, got ${args._.join(' ')}`);
  const file = args._[0] || 'firestore.rules';
  const src = read(file);

  if (command === 'strip') {
    const out = lib.stripComments(src);
    if (args.out) fs.writeFileSync(args.out, out);
    else process.stdout.write(out);
    return 0;
  }

  if (command === 'calibrate') {
    const actual = number(args.actual, '--actual');
    if (actual === undefined) fail('calibrate needs --actual N, the "actual: N bytes" from the refused release');
    let ratio;
    try { ratio = lib.calibrate(src, actual); } catch (err) { fail(err.message); }
    process.stdout.write(`${ratio.toFixed(4)}\n`);
    process.stderr.write(`Pass it as --ratio ${ratio.toFixed(4)}. It holds for this ruleset as it was deployed; measure again after large changes.\n`);
    return 0;
  }

  let result;
  try {
    result = lib.check(src, {
      failAt: number(args.failAt, '--fail-at'), warnAt: number(args.warnAt, '--warn-at'),
      ratio: number(args.ratio, '--ratio'), ignoreSource: !!args.ignoreSource,
    });
  } catch (err) { fail(err.message); }

  if (args.json) {
    process.stdout.write(`${JSON.stringify({ file, ...result }, null, 2)}\n`);
    return result.status === 'fail' ? 1 : 0;
  }

  const mark = { ok: 'ok  ', warn: 'WARN', fail: 'FAIL' };
  const w = Math.max(...result.lines.map((l) => l.label.length));
  process.stdout.write(`\n${file}\n\n`);
  process.stdout.write(`  ${'file'.padEnd(w)}  ${fmt(result.sourceBytes).padStart(9)} bytes, ${pct(result.commentBytes / (result.sourceBytes || 1))} of it comments\n`);
  for (const l of result.lines) {
    process.stdout.write(`  ${l.label.padEnd(w)}  ${fmt(l.bytes).padStart(9)} bytes  ${pct(l.share).padStart(6)} of ${fmt(l.cap)}  ${mark[l.status]}\n`);
  }
  process.stdout.write('\n');
  if (result.status === 'fail') {
    process.stdout.write(`Past ${pct(result.failAt)} of a Firestore ceiling. Past 100% the rules release is refused.\n`);
    const compiled = result.lines.find((l) => l.key === 'compiled');
    if (compiled.status === 'fail') {
      process.stdout.write('The compiled estimate already has comments removed, so the rules themselves must get smaller:\nshare repeated conditions in functions, or move a write behind a server and deny it here.\n');
    } else {
      process.stdout.write('Comments count toward the source ceiling. Deploy a stripped copy (the strip command)\nand run this check with --ignore-source.\n');
    }
  } else if (result.status === 'warn') {
    process.stdout.write(`Past ${pct(result.warnAt)} of a Firestore ceiling. Still passing.\n`);
  }
  return result.status === 'fail' ? 1 : 0;
}

process.exitCode = main();
