# firestore-rules-size

Know how close your Firestore security rules are to their size ceilings, in a pull request, before a deploy tells you.

## What it does

- **Checks a rules file against both Firestore ceilings** and fails your build at a share you choose.
- **Shows where the bytes go:** total size, how much of it is comments, and the size with comments removed.
- **Strips comments for deploy,** so you can keep explanatory comments in git without paying for them at release.
- **Calibrates to your ruleset,** so the compiled estimate uses your own figure.
- Runs as a **command-line tool**, a **GitHub Action** or a **library**. No dependencies. Node 18 or later.

## Why you would want it

Firestore refuses a ruleset that is too large, and nothing warns you beforehand:

- The Firestore emulator loads an oversized ruleset without complaint.
- The Firebase CLI has no size check of its own.
- The limit is enforced when the rules are released, which for most teams is after the merge.

When it happens, the release is refused with a message like this, and every deploy after it is refused too until the rules shrink:

```
Total size of compiled executables must be smaller than 256000 bytes (actual: N bytes).
```

## The two ceilings

| Ceiling | Limit | What counts |
|---|---|---|
| Source text | 262,144 bytes (256 KiB) | Everything in the file, comments included |
| Compiled ruleset | 256,000 bytes (250 KiB) | The rules after compilation; comments are free |

Both are Google's documented limits: see [Firestore usage and limits](https://firebase.google.com/docs/firestore/usage#security_rules), which lists a 256 KB limit on the ruleset source and a 250 KB limit on the compiled ruleset. That page names no way to check either before a deploy, which is the gap this tool fills.

The source size is measured exactly. The compiled size cannot be computed locally, so it is **estimated**: the size with comments removed, multiplied by a ratio. See [Use your own ratio](#use-your-own-ratio).

## Use

```bash
npx github:reworkio/firestore-rules-size                 # checks ./firestore.rules
npx github:reworkio/firestore-rules-size path/to/firestore.rules --fail-at 0.9
```

```
firestore.rules

  file                    231,050 bytes, 30.5% of it comments
  source text             231,050 bytes   88.1% of 262,144  WARN
  compiled (estimated)    224,910 bytes   87.9% of 256,000  WARN

Past 85.0% of a Firestore ceiling. Still passing.
```

Exit status is `0` when passing (a warning still passes), `1` past `--fail-at`, and `2` for bad usage or an unreadable file.

| Option | Default | Meaning |
|---|---|---|
| `--fail-at <0-1>` | `0.95` | Share of a ceiling that fails the check |
| `--warn-at <0-1>` | `0.85` | Share that prints a warning |
| `--ratio <n>` | `1.4` | Compiled bytes per byte of comment-free source |
| `--ignore-source` | off | Your deploy strips comments, so judge the source ceiling on the comment-free size |
| `--json` | off | Machine-readable output |

### GitHub Action

```yaml
- uses: actions/checkout@v4
- uses: reworkio/firestore-rules-size@v0.1.0
  with:
    file: firestore.rules
    fail-at: '0.95'
    # ratio: '1.4'            your own figure, once you have one
    # ignore-source: 'true'   if your deploy strips comments
```

### Use your own ratio

The default ratio (`1.4`) is a starting assumption. Rulesets compile denser or sparser than that, so the estimate is a warning light with a margin, not a measurement. Replace it with your own figure as soon as you have one.

Whenever Firebase reports a compiled size for your rules (the `actual: N bytes` in the message above), pass it with the rules file that was deployed:

```bash
npx github:reworkio/firestore-rules-size calibrate firestore.rules --actual <N>
```

It prints the ratio for your ruleset. Pass that as `--ratio` from then on, and measure again after large changes to the rules.

### Strip comments for deploy

Comments count toward the source ceiling. To keep them in git and deploy without them:

```bash
npx github:reworkio/firestore-rules-size strip firestore.rules -o firestore.deploy.rules
```

Quoted strings are read as strings, so a `//` inside `matches('https://.*')` is kept. Line numbers in deploy-time rule errors will refer to the stripped file. Once your deploy uses the stripped copy, run the check with `--ignore-source`.

### As a library

```js
const fs = require('fs');
const { check, measure, stripComments, calibrate } = require('firestore-rules-size');

const result = check(fs.readFileSync('firestore.rules', 'utf8'), { failAt: 0.9, ratio: 1.4 });
// result.status: 'ok' | 'warn' | 'fail'
// result.lines:  [{ key: 'source' | 'compiled', bytes, cap, share, status }]
```

## When the check fails

Cheapest first:

1. **Source ceiling:** deploy a stripped copy. This does nothing for the compiled ceiling.
2. **Share repeated conditions.** Where many `match` blocks carry near-identical `allow` clauses, a function collapses them, and the compiled ruleset shrinks too.
3. **Move writes behind a server.** Validation of client writes (field allowlists, value checks, state transitions) can be a large part of a ruleset. A write that goes through a server with the Admin SDK needs one line: `allow write: if false;`.
4. **Split into several databases,** each with its own ruleset. A real option, and an architecture change.

The ceilings are Firestore's. Raising them in this tool does not move them.

## What it does not do

- It does not compile rules. The compiled figure is an estimate.
- It does not check Firestore's other limits (nesting depth, expressions per request, `get()` and `exists()` calls per rule).
- It does not test that the rules are correct. Use the emulator and `@firebase/rules-unit-testing` for that.

## Licence

MIT
