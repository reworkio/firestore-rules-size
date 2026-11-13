'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const lib = require('../lib');

const CLI = path.join(__dirname, '..', 'bin', 'cli.js');
const run = (args, cwd) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd });

const RULES = `rules_version = '2';
// who may read
service cloud.firestore {
  match /databases/{database}/documents {
    /* a block
       comment */
    match /posts/{id} {
      allow read: if true; // anyone

      allow write: if request.auth != null && resource.data.url.matches('https://.*');
    }
  }
}
`;

test('comments go, code and strings stay', () => {
  const out = lib.stripComments(RULES);
  assert.ok(!/who may read|a block|anyone/.test(out));
  assert.ok(out.includes("matches('https://.*')"), 'a // inside a string was cut');
  assert.ok(out.includes('      allow read: if true;\n      allow write'), 'trailing space or a blank line was left behind');
  assert.ok(out.startsWith("rules_version = '2';\nservice cloud.firestore {"));
  assert.strictEqual(lib.stripComments(out), out, 'stripping twice changes the file');
});

test('a comment marker inside either kind of quote, or after an escaped quote, is code', () => {
  for (const s of ['"a // b"', "'a /* b */ c'", '"say \\"hi\\" // still a string"']) {
    assert.strictEqual(lib.stripComments(`allow read: if x == ${s};\n`), `allow read: if x == ${s};\n`);
  }
});

test('an unterminated block comment runs to the end and never loops', () => {
  assert.strictEqual(lib.stripComments('allow read;\n/* never closed'), 'allow read;\n');
});

test('measure counts bytes, not characters, and estimates with the ratio', () => {
  const m = lib.measure('// é\nallow read;\n', { ratio: 2 });
  assert.strictEqual(m.sourceBytes, 18);
  assert.strictEqual(m.codeBytes, 12);
  assert.strictEqual(m.commentBytes, 6);
  assert.strictEqual(m.compiledBytes, 24);
  assert.throws(() => lib.measure('x', { ratio: 0 }), RangeError);
});

test('the ceilings are fixed, and the default ratio is only a default', () => {
  assert.strictEqual(lib.COMPILED_CAP, 256000);
  assert.strictEqual(lib.SOURCE_CAP, 262144);
  const src = 'allow read: if true;\n'.repeat(100);
  assert.strictEqual(lib.measure(src).compiledBytes, Math.round(lib.measure(src).codeBytes * lib.DEFAULT_RATIO));
  assert.strictEqual(lib.measure(src, { ratio: 2 }).compiledBytes, lib.measure(src).codeBytes * 2);
});

const pad = (n) => `match /c/{d} { allow read: if true; }\n`.repeat(Math.ceil(n / 38)).slice(0, n);

test('check: ok, warn and fail on the compiled estimate', () => {
  const at = (share) => lib.check(pad(Math.round((lib.COMPILED_CAP * share) / lib.DEFAULT_RATIO)));
  assert.strictEqual(at(0.5).status, 'ok');
  assert.strictEqual(at(0.9).status, 'warn');
  assert.strictEqual(at(0.96).status, 'fail');
  assert.strictEqual(at(0.96).lines.find((l) => l.key === 'compiled').status, 'fail');
});

test('check: comments count toward the source ceiling unless the deploy strips them', () => {
  const src = `${'// a comment line that compiles to nothing\n'.repeat(6000)}allow read;\n`;
  const plain = lib.check(src);
  assert.strictEqual(plain.lines.find((l) => l.key === 'source').status, 'fail');
  assert.strictEqual(plain.lines.find((l) => l.key === 'compiled').status, 'ok');
  assert.strictEqual(lib.check(src, { ignoreSource: true }).status, 'ok');
});

test('check refuses a threshold that is not a share', () => {
  assert.throws(() => lib.check('x', { failAt: 95 }), RangeError);
  assert.throws(() => lib.check('x', { warnAt: 0 }), RangeError);
});

test('calibrate gives the ratio that makes the estimate equal what Firebase said', () => {
  const src = pad(10000);
  const ratio = lib.calibrate(src, 14321);
  assert.strictEqual(lib.measure(src, { ratio }).compiledBytes, 14321);
  assert.throws(() => lib.calibrate('', 10), RangeError);
});

test('cli: exit 0 when ok, 1 past the line, 2 on bad usage', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frs-'));
  fs.writeFileSync(path.join(dir, 'firestore.rules'), RULES);
  fs.writeFileSync(path.join(dir, 'big.rules'), pad(190000));

  const ok = run([], dir);
  assert.strictEqual(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /compiled \(estimated\)/);

  const big = run(['big.rules'], dir);
  assert.strictEqual(big.status, 1);
  assert.match(big.stdout, /FAIL/);
  assert.strictEqual(run(['big.rules', '--fail-at', '1', '--warn-at', '1', '--ratio', '1'], dir).status, 0);

  const json = JSON.parse(run(['check', 'big.rules', '--json'], dir).stdout);
  assert.strictEqual(json.status, 'fail');
  assert.strictEqual(json.file, 'big.rules');

  assert.strictEqual(run(['missing.rules'], dir).status, 2);
  assert.strictEqual(run(['--fail-at', 'lots'], dir).status, 2);
  assert.strictEqual(run(['--nope'], dir).status, 2);
  assert.strictEqual(run(['--fail-at'], dir).status, 2);
});

test('cli: strip prints or writes the stripped file, calibrate prints the ratio', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frs-'));
  fs.writeFileSync(path.join(dir, 'firestore.rules'), RULES);
  assert.strictEqual(run(['strip'], dir).stdout, lib.stripComments(RULES));
  assert.strictEqual(run(['strip', 'firestore.rules', '-o', 'out.rules'], dir).status, 0);
  assert.strictEqual(fs.readFileSync(path.join(dir, 'out.rules'), 'utf8'), lib.stripComments(RULES));
  assert.strictEqual(fs.readFileSync(path.join(dir, 'firestore.rules'), 'utf8'), RULES, 'strip changed the source file');

  const cal = run(['calibrate', '--actual', '1000'], dir);
  assert.strictEqual(cal.status, 0);
  assert.strictEqual(Number(cal.stdout), Number(lib.calibrate(RULES, 1000).toFixed(4)));
  assert.strictEqual(run(['calibrate'], dir).status, 2);
});
