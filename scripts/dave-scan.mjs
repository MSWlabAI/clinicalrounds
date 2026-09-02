#!/usr/bin/env node
/**
 * dave-scan — deterministic security scan for a lab app.
 * =====================================================
 *
 * Dave is the lab's DevSecOps agent. This script is his *senses*: everything
 * here is deterministic, dependency-free and cheap, so it can run nightly in CI
 * and on demand via `/dave` without spending a single model token. Only when
 * this script reports findings does the workflow wake the model up to triage
 * them (see .github/workflows/dave-nightly.yml).
 *
 * What it checks
 * --------------
 *   1. npm audit            — known advisories in the dependency tree
 *   2. npm outdated         — upgrade candidates, each annotated with its
 *                             registry publish age and whether it clears the
 *                             supply-chain COOLDOWN in .npmrc (min-release-age)
 *   3. install scripts      — packages in the lockfile that run code at install
 *                             time, checked against package.json allowScripts. A
 *                             dependency that is NEW *and* has an install script
 *                             is the highest-signal supply-chain tell there is.
 *   4. registry signatures  — `npm audit signatures`: were the tarballs we
 *                             actually installed signed by the registry?
 *   5. policy drift         — the lab's own guardrails (cooldown configured,
 *                             dependabot present, no dangerous workflow
 *                             triggers, no unpinned third-party actions)
 *
 * It also folds in JSON written by external scanners, if the caller ran them
 * first and dropped their output in the same directory (CI does; a local
 * `/dave` run usually doesn't):
 *
 *   <out>/osv.json     — osv-scanner --format json
 *   <out>/zizmor.json  — zizmor --format json
 *   <out>/gitleaks.json— gitleaks detect --report-format json
 *
 * Usage
 * -----
 *   node scripts/dave-scan.mjs [--out .dave/out] [--offline] [--quiet]
 *
 * Exit codes
 * ----------
 *   0  clean — nothing actionable
 *   1  findings — see <out>/report.json and <out>/report.md
 *   2  the scan itself failed (broken tree, no network where required, ...)
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { frameworkMajorFindings, workflowTriggers } from './dave-scan-lib.mjs';

// ── CLI ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const getFlag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};
const OUT_DIR = resolve(String(getFlag('out', '.dave/out')));
const OFFLINE = Boolean(getFlag('offline', false));
const QUIET = Boolean(getFlag('quiet', false));
/**
 * Cheap tier: run only the checks that need nothing installed — audit, OSV,
 * install-script allowlist, policy and workflow drift. The fleet digest
 * (MSWlabAI/dave-fleet) sweeps ~50 apps a night and cannot afford an `npm ci`
 * per app, so it materializes each app's manifest files and runs THIS scanner
 * over them. Sharing the scanner is the point: the fleet layer gets Dave's real
 * detectors and his exact finding ids, instead of a second copy that drifts.
 *
 * This must never be the default. Per-app Dave runs after `npm ci`, where an
 * uninstalled tree means something is broken and `degraded` is the honest
 * answer. The flag only says "the install tier was not attempted", which the
 * report already expresses by omitting those names from `scanners`.
 */
const CHEAP = Boolean(getFlag('cheap', false));

const log = (...a) => {
  if (!QUIET) console.error(...a);
};

// ── Severity model ─────────────────────────────────────────────────────────
const SEVERITIES = ['critical', 'high', 'moderate', 'low', 'info'];
const severityRank = (s) => {
  const i = SEVERITIES.indexOf(String(s || 'info').toLowerCase());
  return i === -1 ? SEVERITIES.length : i;
};
/** Map the many vocabularies scanners use onto ours. */
const normalizeSeverity = (s) => {
  const v = String(s || '').toLowerCase();
  if (['critical'].includes(v)) return 'critical';
  if (['high', 'error'].includes(v)) return 'high';
  if (['moderate', 'medium', 'warning'].includes(v)) return 'moderate';
  if (['low', 'note'].includes(v)) return 'low';
  return 'info';
};

const findings = [];
const errors = [];

/**
 * Scanners that FAILED to reach a verdict, as opposed to ones deliberately
 * skipped (offline, no node_modules) which are simply absent from `scanners`.
 *
 * This is the difference between "we looked and found nothing" and "we could
 * not look". Only the first may ever be reported as clean. An empty findings
 * list plus a non-empty `degraded` is an UNKNOWN result, and the process exits
 * 2 so the workflow reports an error instead of an all-clear.
 */
const degraded = new Set();

/** Registry reachability, so one odd package is not confused with an outage. */
const registryStats = { attempted: 0, failed: 0 };
const addFinding = (f) => {
  findings.push({ autoFixable: false, ...f, severity: normalizeSeverity(f.severity) });
};

/** Run a command, never throw. Returns { code, stdout, stderr }. */
const run = (cmd, args, opts = {}) => {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : String(err.message || err),
    };
  }
};

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

const parseJson = (text) => {
  if (!text || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    // npm sometimes prefixes JSON with warnings; salvage the first {...} block.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
};

// ── Policy: the supply-chain cooldown ──────────────────────────────────────
/**
 * Read `min-release-age` out of .npmrc. This is the number of DAYS a version
 * must have been public before we are willing to adopt it — the single most
 * effective defense against the 2025–2026 wave of npm account-takeover attacks,
 * where malicious versions were typically yanked within hours.
 */
const readCooldownDays = () => {
  if (!existsSync('.npmrc')) return 0;
  const m = readFileSync('.npmrc', 'utf8').match(/^\s*min-release-age\s*=\s*(\d+)/m);
  return m ? Number(m[1]) : 0;
};
const COOLDOWN_DAYS = readCooldownDays();

// ── Registry lookups (publish dates) ───────────────────────────────────────
const registryCachePath = join(OUT_DIR, 'registry-cache.json');
let registryCache = {};

/**
 * Publish timestamps for one package, as { version: isoDate }.
 * The abbreviated packument omits `time`, so the full document is the only
 * source — we therefore only ever call this for packages npm already told us
 * are outdated, and we cache within a run.
 */
const fetchPublishTimes = async (name) => {
  if (registryCache[name]) return registryCache[name];
  if (OFFLINE) return null;
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`;
  registryStats.attempted += 1;
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const doc = await res.json();
    registryCache[name] = doc.time || {};
    return registryCache[name];
  } catch (err) {
    registryStats.failed += 1;
    errors.push(`registry lookup failed for ${name}: ${err.message}`);
    return null;
  }
};

const ageInDays = (iso) => {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((Date.now() - then) / 86_400_000);
};

// ── Check 1: npm audit ─────────────────────────────────────────────────────
const checkAudit = () => {
  const { stdout, stderr, code } = run('npm', ['audit', '--json']);
  const report = parseJson(stdout);
  if (!report) {
    errors.push(`npm audit produced no parseable JSON (exit ${code}): ${stderr.slice(0, 400)}`);
    degraded.add('npm-audit');
    return { advisoryPackages: new Set(), advisoryIds: new Set() };
  }

  const advisoryPackages = new Set();
  // GHSA identifiers npm already knows about, so the OSV pass can skip them.
  const advisoryIds = new Set();
  const vulns = report.vulnerabilities || {};

  for (const [name, v] of Object.entries(vulns)) {
    advisoryPackages.add(name);

    // `via` holds either advisory objects (direct cause) or bare package names
    // (this package is only vulnerable *because* something it depends on is).
    const advisories = (v.via || []).filter((x) => x && typeof x === 'object');
    const titles = advisories.map((a) => a.title).filter(Boolean);
    const urls = advisories.map((a) => a.url).filter(Boolean);
    const viaNames = (v.via || []).filter((x) => typeof x === 'string');
    for (const url of urls) {
      const ghsa = /GHSA-[\w-]+/.exec(url);
      if (ghsa) advisoryIds.add(ghsa[0]);
    }

    // `fixAvailable` is true / false / { name, version, isSemVerMajor }
    const fix = v.fixAvailable;
    const fixDesc =
      fix === true
        ? 'npm audit fix'
        : fix && typeof fix === 'object'
          ? `${fix.name}@${fix.version}${fix.isSemVerMajor ? ' (MAJOR — breaking)' : ''}`
          : 'no fix published';

    addFinding({
      id: `npm-audit:${name}`,
      source: 'npm-audit',
      severity: v.severity,
      package: name,
      title: titles[0] || `${name} is affected by a published advisory`,
      detail: [
        titles.length > 1 ? `${titles.length} advisories: ${titles.join('; ')}` : null,
        viaNames.length ? `Vulnerable via: ${viaNames.join(', ')}` : null,
        v.range ? `Affected range: ${v.range}` : null,
        `Fix: ${fixDesc}`,
        v.isDirect ? 'This is a DIRECT dependency.' : 'Transitive dependency.',
      ]
        .filter(Boolean)
        .join('\n'),
      references: urls,
      // Auto-fixable only when npm can do it without a major bump. Majors are
      // breaking changes and must be a human decision.
      autoFixable: fix === true || (fix && typeof fix === 'object' && !fix.isSemVerMajor),
      fixedIn: fix && typeof fix === 'object' ? `${fix.name}@${fix.version}` : null,
    });
  }

  return { advisoryPackages, advisoryIds };
};

/**
 * A static blast-radius estimate: how many tracked source files import `name`.
 * `git grep -l` respects .gitignore and never executes app code (unlike a
 * dynamic import would). Exit 1 just means no matches; >1 is a real error and we
 * return null so "unknown" is not confused with "zero".
 */
const importSiteCount = (name) => {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const res = run('git', [
    'grep', '-l', '-E', `['"]${esc}(/|['"])`,
    '--', '*.ts', '*.tsx', '*.js', '*.jsx', '*.mjs', '*.cjs',
  ]);
  if (res.code > 1) return null;
  const out = res.stdout.trim();
  return out ? out.split('\n').length : 0;
};

// ── Check 2: outdated packages, annotated with cooldown ────────────────────
const checkOutdated = async (advisoryPackages) => {
  // In the cheap tier there is no installed tree by construction, so this check
  // is out of scope rather than broken. Return before spawning npm: the caller
  // leaves 'outdated' out of `scanners`, and the report says we did not look.
  if (CHEAP) return [];

  const { stdout } = run('npm', ['outdated', '--json']); // exit 1 when anything is outdated
  const outdated = parseJson(stdout) || {};
  const upgrades = [];

  // Without node_modules, `npm outdated` reports no `current` for anything and
  // lists the whole dependency set as "outdated" — every package looks like an
  // available upgrade when really the tree just isn't installed. Printing that
  // table is worse than printing nothing: it reads as 30 pending upgrades.
  const entries = Object.entries(outdated);
  const anyInstalled = entries.some(([, raw]) => (Array.isArray(raw) ? raw[0] : raw)?.current);
  if (entries.length && !anyInstalled) {
    degraded.add('outdated');
    errors.push(
      'no installed dependency versions found — `npm outdated` cannot compare against an ' +
        'uninstalled tree, so upgrade and cooldown analysis was skipped. Run `npm ci` first.',
    );
    return [];
  }

  for (const [name, rawInfo] of entries) {
    // npm emits an array when a package resolves at several tree locations.
    const info = Array.isArray(rawInfo) ? rawInfo[0] : rawInfo;
    if (!info) continue;
    // A single package missing `current` is not installed at all — it cannot be
    // an "upgrade", and its cooldown number would be meaningless.
    if (!info.current) continue;

    const securityDriven = advisoryPackages.has(name);
    // Prefer the semver-compatible upgrade; `latest` may be a major bump.
    const target = info.wanted && info.wanted !== info.current ? info.wanted : info.latest;
    if (!target || target === info.current) continue;

    const times = await fetchPublishTimes(name);
    const days = times ? ageInDays(times[target]) : null;
    // Unknown age is treated as NOT clearing the cooldown — fail closed.
    const cooldownOk = COOLDOWN_DAYS === 0 ? true : days !== null && days >= COOLDOWN_DAYS;

    upgrades.push({
      name,
      current: info.current ?? null,
      wanted: info.wanted ?? null,
      latest: info.latest ?? null,
      target,
      isMajor:
        info.current && info.latest
          ? String(info.current).split('.')[0] !== String(target).split('.')[0]
          : null,
      publishedDaysAgo: days,
      cooldownOk,
      // Advisory-driven fixes are exempt from the cooldown — the same carve-out
      // dependabot.yml makes. Waiting 7 days to patch a known-exploited CVE is
      // strictly worse than adopting a fresh version.
      cooldownExempt: securityDriven,
      securityDriven,
    });
  }

  upgrades.sort((a, b) => Number(b.securityDriven) - Number(a.securityDriven) || a.name.localeCompare(b.name));

  // Only *blocked* upgrades are worth a finding; routine drift is dependabot's job.
  const blocked = upgrades.filter((u) => u.securityDriven && !u.cooldownOk && !u.cooldownExempt);
  for (const u of blocked) {
    addFinding({
      id: `cooldown:${u.name}`,
      source: 'cooldown',
      severity: 'moderate',
      package: u.name,
      title: `${u.name}@${u.target} fixes an advisory but is only ${u.publishedDaysAgo ?? '?'} days old`,
      detail: `The supply-chain cooldown is ${COOLDOWN_DAYS} days. Adopting this version early is a deliberate risk trade-off and needs a human decision.`,
    });
  }

  // A framework-tier major (Next, React, Convex, Clerk…) is a migration, not a
  // bump. Dave surfaces it as an advisory-only finding — he never performs one,
  // and dave-verify rejects a framework-tier major even inside his file remit.
  for (const f of frameworkMajorFindings(upgrades, importSiteCount)) addFinding(f);

  return upgrades;
};

// ── Check 3: install scripts vs npm's own allowlist ───────────────────────
/**
 * Packages with install scripts execute arbitrary code on `npm install` — the
 * delivery mechanism for the Shai-Hulud / keyv worm family.
 *
 * npm enforces this natively now: `strict-allow-scripts=true` in .npmrc blocks
 * any install script whose package@version is not listed in package.json's
 * `allowScripts`. That list is VERSION-PINNED, which is the property that
 * matters — approval does not carry to a new release, so a compromised version
 * of an already-trusted package re-enters review.
 *
 * Dave does not keep a second list. He watches the GAP between what npm would
 * enforce and what is actually in the tree, because that gap is real: per
 * .npmrc, Vercel's builder still ships npm 11.12.x where strict-allow-scripts
 * is advisory only. A package npm blocks locally can still run in a production
 * build, and that is exactly the blind spot worth a nightly check.
 */
const checkInstallScripts = () => {
  const lock = readJson('package-lock.json');
  if (!lock) {
    errors.push('package-lock.json missing or unparseable — cannot audit install scripts');
    degraded.add('install-scripts');
    return { skipped: 'no lockfile' };
  }

  // Every package@version in the tree that runs code at install time.
  const inTree = [];
  for (const [path, meta] of Object.entries(lock.packages || {})) {
    if (!meta?.hasInstallScript || !meta.version) continue;
    // "node_modules/a/node_modules/@scope/b" → "@scope/b"
    const name = path.split('node_modules/').pop();
    if (name) inTree.push({ name, version: meta.version, key: `${name}@${meta.version}` });
  }

  const pkg = readJson('package.json') || {};
  const allowScripts = pkg.allowScripts;
  const current = [...new Set(inTree.map((p) => p.key))].sort();

  if (!allowScripts || typeof allowScripts !== 'object') {
    addFinding({
      id: 'policy:allowscripts-missing',
      source: 'policy',
      severity: 'high',
      title: 'No install-script allowlist (`allowScripts`) in package.json',
      detail:
        `${current.length} package(s) in this tree run code at install time with nothing gating them:\n` +
        `${current.map((k) => `  - ${k}`).join('\n')}\n\n` +
        'Build the allowlist with `npm approve-scripts` (read each script; never use --all), ' +
        'and set `strict-allow-scripts=true` in .npmrc so npm enforces it.',
    });
    return { current, allowlist: null };
  }

  // Only `true` means approved. Anything else is an explicit denial.
  const approved = new Set(
    Object.entries(allowScripts)
      .filter(([, v]) => v === true)
      .map(([k]) => k),
  );
  const approvedNames = new Set(
    [...approved].map((k) => k.slice(0, k.lastIndexOf('@'))).filter(Boolean),
  );

  const unapproved = [];
  const versionDrift = [];
  for (const { name, key } of inTree) {
    if (approved.has(key)) continue;
    // Distinguish "we trust this package but never reviewed THIS build" from
    // "this package is new and unreviewed". The first is the supply-chain case
    // the version pinning exists to catch.
    (approvedNames.has(name) ? versionDrift : unapproved).push(key);
  }

  for (const key of [...new Set(versionDrift)]) {
    const name = key.slice(0, key.lastIndexOf('@'));
    addFinding({
      id: `install-script:version:${key}`,
      source: 'install-script',
      severity: 'high',
      package: name,
      title: `${key} runs an install script at a version that was never approved`,
      detail:
        `\`${name}\` is in allowScripts, but at a different version — approval deliberately does ` +
        'not carry across releases. This is exactly the shape of a compromised update to a package ' +
        'you already trust.\n\nRead the new version\'s install script, then re-approve with ' +
        '`npm approve-scripts --allow-scripts-pending`. Do not approve blind.',
    });
  }

  for (const key of [...new Set(unapproved)]) {
    addFinding({
      id: `install-script:new:${key}`,
      source: 'install-script',
      severity: 'high',
      package: key.slice(0, key.lastIndexOf('@')),
      title: `New dependency with an unapproved install script: ${key}`,
      detail:
        'This package runs code at install time and is not in package.json\'s allowScripts. ' +
        'Confirm it arrived deliberately and read what its install script actually does before ' +
        'approving it. npm >= 11.16 blocks this locally and in CI, but Vercel\'s builder ' +
        '(npm 11.12.x) does NOT — so an unapproved script can still execute in a production build.',
    });
  }

  return {
    current,
    allowlist: [...approved].sort(),
    unapproved: [...new Set(unapproved)],
    versionDrift: [...new Set(versionDrift)],
  };
};

// ── Check 4: registry signatures / provenance ──────────────────────────────
const checkSignatures = () => {
  if (OFFLINE) return { skipped: 'offline' };
  if (!existsSync('node_modules')) return { skipped: 'node_modules not installed' };

  // --min-release-age=0 is deliberate and load-bearing. The cooldown governs
  // what we INSTALL; this command verifies what is ALREADY installed. With the
  // cooldown applied npm filters its registry view to versions older than the
  // window, so a dependency legitimately pinned to a recent version becomes
  // unresolvable and the whole command dies with ETARGET:
  //
  //   npm error notarget No matching version found for nanoid@3.3.18
  //   with a date before 8/1/2026
  //
  // Verifying a signature is not installing a package, so the cooldown has no
  // business filtering this.
  const { stdout, stderr, code } = run('npm', ['audit', 'signatures', '--min-release-age=0']);
  const text = `${stdout}\n${stderr}`;

  const summary = /(\d[\d,]*) packages have verified registry signatures/.exec(text);

  // npm exits non-zero both when a signature is genuinely bad AND when the
  // command could not run at all. Those are opposite facts and must not share
  // a finding.
  //
  // "The check could not run" means the tree is UNVERIFIED — not known-bad.
  // Reporting an inability to look as a positive detection of tampering is the
  // same error as reporting a failed scan as clean, just pointed the other way,
  // and at critical severity it would invoke the model and turn Slack red every
  // night over a tooling fault. The presence of npm's own summary line is what
  // distinguishes them: npm only prints it once it has actually audited.
  if (code !== 0 && !summary) {
    const why = (/npm error code (\S+)/.exec(text) || [, 'unknown'])[1];
    addFinding({
      id: 'provenance:signature-check-failed',
      source: 'provenance',
      severity: 'low',
      title: `Could not verify registry signatures (npm error ${why})`,
      detail:
        'The signature check did not complete, so the tarballs in this tree are UNVERIFIED — ' +
        'this is not evidence that anything is wrong with them. Fix the tooling error, then ' +
        're-run before drawing any conclusion.\n\n' +
        text.slice(0, 1500),
    });
    return { verified: null, error: why, raw: text.slice(0, 4000) };
  }

  // npm ran the audit and something in the tree failed it. This one is real.
  if (code !== 0) {
    const invalid = text
      .split('\n')
      .filter((l) => /invalid|missing|failed/i.test(l))
      .slice(0, 40)
      .join('\n');
    addFinding({
      id: 'provenance:signature-verification',
      source: 'provenance',
      severity: 'critical',
      title: 'One or more installed packages failed registry signature verification',
      detail:
        'A tarball in the tree does not match what the npm registry signed. This is what a ' +
        'tampered or substituted package looks like. Do not deploy until this is explained.\n\n' +
        (invalid || text.slice(0, 1500)),
    });
    return { verified: false, raw: text.slice(0, 4000) };
  }

  const verified = summary;
  const attested = /(\d[\d,]*) packages have verified attestations/.exec(text);
  return {
    verified: true,
    signedPackages: verified ? Number(verified[1].replace(/,/g, '')) : null,
    attestedPackages: attested ? Number(attested[1].replace(/,/g, '')) : null,
  };
};

// ── Check 5: OSV, queried directly over HTTP ───────────────────────────────
/**
 * `npm audit` resolves advisories through npm's own view of the tree. Querying
 * OSV with the flat list of everything actually in package-lock.json is a
 * second, independent opinion — it catches advisories npm has not picked up and
 * covers transitive packages npm collapses away. It needs no binary: the OSV
 * batch endpoint takes package+version pairs directly.
 *
 * Advisories npm already reported are skipped, so this only ever *adds*
 * information.
 */
const checkOsv = async (knownAdvisoryIds) => {
  if (OFFLINE) return { skipped: 'offline' };

  const lock = readJson('package-lock.json');
  if (!lock) return { skipped: 'no lockfile' };

  const seen = new Set();
  const queries = [];
  for (const [path, meta] of Object.entries(lock.packages || {})) {
    if (!path || !meta?.version) continue;
    const name = path.split('node_modules/').pop();
    if (!name) continue;
    const key = `${name}@${meta.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    queries.push({ key, package: { name, ecosystem: 'npm' }, version: meta.version });
  }
  if (!queries.length) return { skipped: 'empty lockfile' };

  // id → the package that pulled it in
  const hits = new Map();
  const BATCH = 400;
  for (let i = 0; i < queries.length; i += BATCH) {
    const slice = queries.slice(i, i + BATCH);
    try {
      const res = await fetch('https://api.osv.dev/v1/querybatch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queries: slice.map(({ package: p, version }) => ({ package: p, version })),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      (body.results || []).forEach((result, idx) => {
        for (const v of result.vulns || []) {
          if (!hits.has(v.id)) hits.set(v.id, slice[idx].key);
        }
      });
    } catch (err) {
      errors.push(`OSV batch query failed: ${err.message}`);
      degraded.add('osv');
      return { skipped: 'query failed' };
    }
  }

  const novel = [...hits.keys()].filter((id) => !knownAdvisoryIds.has(id));
  // Detail lookups are one request each; cap them so a tree with a long tail of
  // low-severity advisories can't stall the nightly run.
  const DETAIL_CAP = 40;
  const toDetail = novel.slice(0, DETAIL_CAP);

  for (const id of toDetail) {
    try {
      const res = await fetch(`https://api.osv.dev/v1/vulns/${id}`);
      if (!res.ok) continue;
      const v = await res.json();
      if (v.withdrawn) continue;

      // OSV severity lives in different places depending on the source feed.
      const severity =
        v.database_specific?.severity ||
        v.affected?.find((a) => a.database_specific?.severity)?.database_specific?.severity ||
        'moderate';

      addFinding({
        id: `osv:${id}`,
        source: 'osv',
        severity,
        package: hits.get(id)?.split('@').slice(0, -1).join('@') || null,
        title: `${id}: ${v.summary || 'advisory affecting ' + hits.get(id)}`,
        detail: [
          `Affects: ${hits.get(id)}`,
          v.details ? v.details.slice(0, 900) : null,
          'Reported by OSV but not by `npm audit` — confirm whether the vulnerable path is reachable here.',
        ]
          .filter(Boolean)
          .join('\n\n'),
        references: (v.references || []).map((r) => r.url).filter(Boolean).slice(0, 4),
      });
    } catch {
      /* a single detail lookup failing is not worth failing the scan over */
    }
  }

  return {
    packagesQueried: queries.length,
    advisoriesFound: hits.size,
    novel: novel.length,
    detailed: toDetail.length,
    truncated: novel.length > DETAIL_CAP,
  };
};

// ── Check 6: security drift against the template we track ─────────────────
/**
 * A lab app is a snapshot of the template. When the template — or the upstream
 * it tracks, `harperaa/secure-vibe-coding-OS` — ships a security fix to the
 * shared backend (middleware, CSP, auth, rate limiting, the security skills),
 * every app carrying an older copy is quietly vulnerable and nothing tells it.
 *
 * `upstream-sync.yml` only solves this for the template itself. This check
 * closes it for the apps.
 *
 * The comparison is a plain two-tree diff (`git diff HEAD FETCH_HEAD -- paths`)
 * rather than a commit count, deliberately: an app created with
 * `gh repo create --template` has NO shared history with the template, so
 * `HEAD..FETCH_HEAD` would be meaningless there. Comparing file content works
 * for both the fork case and the template-created case.
 */
const SECURITY_PATHS = [
  'middleware.ts',
  'lib/',
  'convex/',
  'app/api/',
  '.claude/skills/security/',
  '.claude/agents/',
  '.github/workflows/',
  '.github/dependabot.yml',
  '.npmrc',
  'scripts/',
];

const checkUpstream = () => {
  if (OFFLINE) return { skipped: 'offline' };
  // Drift is measured by fetching the template and diffing it against THIS
  // checkout. The cheap tier has no checkout — it runs over materialized
  // manifest files — so the check cannot mean anything there and would degrade
  // every single lab app, turning a clean app's verdict into UNKNOWN. The fleet
  // digest reports coverage and drift itself; per-app Dave does this properly
  // against a real working tree with a real credential.
  if (CHEAP) return { skipped: 'no working tree (cheap tier)' };

  const cfg = readJson('lab.config.json');
  if (!cfg?.labTemplateRepo) return { skipped: 'no lab.config.json' };

  // Same two-tier resolution /pull-agents uses: the template tracks Harper,
  // an app tracks the template (so apps never take Harper's billing layer).
  const originUrl = run('git', ['remote', 'get-url', 'origin']).stdout.trim();
  const weAreTheTemplate =
    originUrl.toLowerCase().includes(String(cfg.labTemplateRepo).toLowerCase()) ||
    // The template repo has been renamed at least once; match either name.
    /lab-svcos/i.test(originUrl);
  const source = weAreTheTemplate ? cfg.upstreamRepo : cfg.labTemplateRepo;
  if (!source) return { skipped: 'no upstream configured' };

  // The lab template is private, and this job deliberately holds no git
  // credential (`persist-credentials: false`). GITHUB_TOKEN cannot stand in:
  // it is scoped to the repo running the workflow and cannot read a different
  // private repo in the org. So a lab app needs an explicitly supplied token to
  // see the template at all — without one, the app-side drift check, which is
  // the one that matters most, silently never runs.
  //
  // Harper's repo is public, so the TEMPLATE's own check works unauthenticated.
  // That asymmetry is why this was easy to miss.
  const token = process.env.DAVE_UPSTREAM_TOKEN || '';
  const url = token
    ? `https://x-access-token:${token}@github.com/${source}.git`
    : `https://github.com/${source}.git`;

  const fetched = run('git', ['fetch', '--no-tags', '--quiet', url, 'main']);
  if (fetched.code !== 0) {
    // NEVER let the token reach a log, a report, or a PR body: git echoes the
    // remote URL back in its own error text.
    const stderr = (token ? fetched.stderr.split(token).join('***') : fetched.stderr)
      .replace(/https:\/\/[^@\s]*@/g, 'https://***@')
      .slice(0, 200);

    const needsAuth = /could not read Username|Authentication failed|not found/i.test(stderr);
    if (needsAuth && !token) {
      errors.push(
        `cannot read ${source}: it is private and no DAVE_UPSTREAM_TOKEN is set, so drift ` +
          'against the lab template was NOT checked tonight. Set the SYNC_TOKEN secret ' +
          '(a PAT with read access to the template) to enable it.',
      );
      degraded.add('upstream');
      return { skipped: 'no credential for a private template', source };
    }

    errors.push(`could not fetch ${source}: ${stderr}`);
    degraded.add('upstream');
    return { skipped: 'fetch failed', source };
  }

  const changed = run('git', ['diff', '--name-only', 'HEAD', 'FETCH_HEAD', '--', ...SECURITY_PATHS])
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

  // Commit subjects are only meaningful when there IS a common ancestor.
  const hasMergeBase = run('git', ['merge-base', 'HEAD', 'FETCH_HEAD']).code === 0;
  let behind = null;
  let subjects = [];
  if (hasMergeBase) {
    const count = run('git', ['rev-list', '--count', 'HEAD..FETCH_HEAD']).stdout.trim();
    behind = Number(count) || 0;
    subjects = run('git', ['log', '--no-merges', '--pretty=format:%s', 'HEAD..FETCH_HEAD'])
      .stdout.split('\n')
      .filter(Boolean)
      .slice(0, 30);
  }

  const result = { source, hasMergeBase, behind, securityPathsChanged: changed.length };
  if (!changed.length) return result;

  // A subject that names a vulnerability is worth more urgency than routine drift.
  const urgent = subjects.filter((s) =>
    /\b(security|vuln|cve|ghsa|advisory|xss|csrf|injection|rce|ssrf|auth|escalat|leak)\b/i.test(s),
  );

  addFinding({
    id: `upstream:drift:${source}`,
    source: 'upstream',
    severity: urgent.length ? 'high' : 'moderate',
    title: `${changed.length} security-relevant file(s) differ from ${source}`,
    detail: [
      behind !== null ? `Behind by ${behind} commit(s).` : 'No shared history — compared by file content.',
      `Files:\n${changed.slice(0, 25).map((f) => `  - ${f}`).join('\n')}` +
        (changed.length > 25 ? `\n  ... +${changed.length - 25} more` : ''),
      urgent.length
        ? `Upstream commits mentioning security:\n${urgent.map((s) => `  - ${s}`).join('\n')}`
        : null,
      'Differing does not by itself mean behind — this fork diverges deliberately in places ' +
        '(see LAB-NOTES.md). Check whether any of these carry a fix this app is missing.',
    ]
      .filter(Boolean)
      .join('\n\n'),
  });

  return result;
};

// ── Check 7: the lab's own guardrails still in place ───────────────────────
const checkPolicyDrift = () => {
  const notes = [];

  if (COOLDOWN_DAYS === 0) {
    addFinding({
      id: 'policy:cooldown-missing',
      source: 'policy',
      severity: 'high',
      title: 'Supply-chain cooldown is not configured',
      detail:
        'No `min-release-age` in .npmrc. Without it, an agent or a developer can install a ' +
        'package version published minutes ago — exactly the window malicious releases live in. ' +
        'Add `min-release-age=7` to .npmrc.',
    });
  } else {
    notes.push(`cooldown: ${COOLDOWN_DAYS} days`);
  }

  if (!existsSync('.github/dependabot.yml')) {
    addFinding({
      id: 'policy:dependabot-missing',
      source: 'policy',
      severity: 'moderate',
      title: 'No dependabot configuration',
      detail: 'Automated dependency PRs are the baseline patch path. Add .github/dependabot.yml.',
    });
  }

  // Does the repo actually enforce the two controls it documents? Without
  // engine-strict, npm 10.x prints "Unknown project config" for min-release-age
  // and installs with ZERO cooldown while the repo still claims protection.
  const npmrc = existsSync('.npmrc') ? readFileSync('.npmrc', 'utf8') : '';
  if (COOLDOWN_DAYS > 0 && !/^\s*engine-strict\s*=\s*true/m.test(npmrc)) {
    addFinding({
      id: 'policy:engine-strict-missing',
      source: 'policy',
      severity: 'high',
      title: 'Cooldown is configured but not enforced (`engine-strict` is off)',
      detail:
        'npm < 11.10.0 ignores `min-release-age` with only a warning, so the cooldown silently ' +
        'does nothing on an older toolchain while the repo still claims to be protected. ' +
        'Set `engine-strict=true` in .npmrc so the install fails instead of degrading quietly.',
    });
  }

  // A workflow pinned below engines.node installs an npm too old to honour the
  // .npmrc controls — and under engine-strict it fails outright. This is a
  // silent-degradation bug that CI itself will not always surface.
  const enginesNode = readJson('package.json')?.engines?.node || '';
  const minNodeMajor = Number(/(\d+)/.exec(enginesNode)?.[1] || 0);

  // Workflow hygiene. zizmor does this far more thoroughly in CI, but these
  // classes are severe enough — and cheap enough — to catch locally too.
  const wfDir = '.github/workflows';
  if (existsSync(wfDir)) {
    for (const file of readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f))) {
      const path = join(wfDir, file);
      const body = readFileSync(path, 'utf8');

      if (minNodeMajor && /\bnpm (ci|install)\b/.test(body)) {
        const tooOld = [...body.matchAll(/node-version:\s*'?"?(\d+)/g)]
          .map((m) => Number(m[1]))
          .filter((v) => v < minNodeMajor);
        if (tooOld.length) {
          addFinding({
            id: `workflow:node-version:${file}`,
            source: 'workflow',
            severity: 'high',
            title: `${file} runs npm on Node ${[...new Set(tooOld)].join('/')}, below engines.node (${enginesNode})`,
            detail:
              `Node ${[...new Set(tooOld)].join('/')} ships an npm older than this repo requires. ` +
              'With engine-strict=true the install fails outright; without it, the npm-level ' +
              'supply-chain controls (min-release-age, strict-allow-scripts) are silently ' +
              `inert. Pin this workflow to Node ${minNodeMajor}.`,
          });
        }
      }

      if (workflowTriggers(body).has('pull_request_target')) {
        addFinding({
          id: `workflow:pull_request_target:${file}`,
          source: 'workflow',
          severity: 'high',
          title: `${file} uses the pull_request_target trigger`,
          detail:
            'pull_request_target runs with repository secrets in the context of a fork PR. ' +
            'Unless it is very carefully written, it hands write-scoped credentials to anyone ' +
            'who can open a pull request.',
        });
      }

      // Third-party actions on a floating tag can be re-pointed by whoever owns
      // the tag; the March 2026 tj-actions class of incident worked exactly this way.
      const unpinned = [...body.matchAll(/uses:\s*([\w.-]+\/[^@\s]+)@(v?[\w.-]+)\s*$/gm)]
        .filter(([, repo]) => !repo.startsWith('actions/') && !repo.startsWith('github/'))
        .filter(([, , ref]) => !/^[0-9a-f]{40}$/.test(ref))
        .map(([, repo, ref]) => `${repo}@${ref}`);
      if (unpinned.length) {
        addFinding({
          id: `workflow:unpinned:${file}`,
          source: 'workflow',
          severity: 'moderate',
          title: `${file} uses third-party actions pinned to a mutable tag`,
          detail: `Pin these to a full commit SHA:\n${[...new Set(unpinned)].map((u) => `  - ${u}`).join('\n')}`,
        });
      }
    }
  }

  return notes;
};

// ── Fold in external scanners, if the caller ran them ──────────────────────
const ingestOsv = () => {
  const doc = readJson(join(OUT_DIR, 'osv.json'));
  if (!doc) return false;
  for (const result of doc.results || []) {
    for (const pkg of result.packages || []) {
      for (const vuln of pkg.vulnerabilities || []) {
        const sev =
          vuln.database_specific?.severity ||
          vuln.severity?.[0]?.score ||
          pkg.groups?.find((g) => g.ids?.includes(vuln.id))?.max_severity ||
          'moderate';
        addFinding({
          id: `osv:${vuln.id}`,
          source: 'osv-scanner',
          severity: normalizeSeverity(typeof sev === 'string' ? sev : 'moderate'),
          package: pkg.package?.name || null,
          title: `${vuln.id}: ${vuln.summary || 'advisory affecting ' + (pkg.package?.name || 'a dependency')}`,
          detail: (vuln.details || '').slice(0, 1200),
          references: (vuln.references || []).map((r) => r.url).filter(Boolean).slice(0, 5),
        });
      }
    }
  }
  return true;
};

/**
 * A zizmor location is a nested object, not a string. Reading the wrong keys
 * off it produced `Location: [object Object],[object Object]` for every zizmor
 * finding — which silently discarded the single piece of information a reviewer
 * needs, on ~87% of the report, every night.
 *
 * Real shape:
 *   locations[].symbolic.key.Local.verbatim_path   absolute path on the runner
 *   locations[].symbolic.annotation                 what is wrong, in words
 *   locations[].concrete.location.start_point.row   0-INDEXED — add 1
 */
const formatZizmorLocation = (loc) => {
  if (!loc) return null;
  const sym = loc.symbolic || {};
  const raw =
    sym.key?.Local?.verbatim_path || sym.key?.Local?.given_path || sym.key?.Remote?.path || '';
  // verbatim_path is absolute on the runner; a repo-relative path is what a
  // reviewer can actually open.
  const path = raw ? raw.replace(`${process.cwd()}/`, '') : '(unknown file)';
  const row = loc.concrete?.location?.start_point?.row;
  const line = Number.isInteger(row) ? `:${row + 1}` : '';
  const route = sym.route?.components
    ?.map((c) => c?.Key ?? c?.Index)
    .filter((c) => c !== undefined && c !== null)
    .join('.');

  return {
    ref: `${path}${line}`,
    detail: [`${path}${line}`, route ? `(${route})` : null, sym.annotation ? `— ${sym.annotation}` : null]
      .filter(Boolean)
      .join(' '),
  };
};

const ingestZizmor = () => {
  const doc = readJson(join(OUT_DIR, 'zizmor.json'));
  if (!doc) return false;
  const items = Array.isArray(doc) ? doc : doc.findings || [];

  for (const item of items) {
    const locations = (item.locations || []).map(formatZizmorLocation).filter(Boolean);
    const primary = locations[0];

    addFinding({
      // Qualify the id by location. Without this every `artipacked` hit shares
      // one id, so eight distinct workflow files collapse into eight identical
      // rows and the run fingerprint cannot tell them apart.
      id: `zizmor:${item.ident || item.desc}${primary ? `:${primary.ref}` : ''}`,
      source: 'zizmor',
      severity: normalizeSeverity(item.determinations?.severity || item.severity),
      title: `GitHub Actions: ${item.desc || item.ident}${primary ? ` (${primary.ref})` : ''}`,
      detail: [
        item.determinations?.confidence ? `Confidence: ${item.determinations.confidence}` : null,
        locations.length
          ? `Location${locations.length > 1 ? 's' : ''}:\n${locations.map((l) => `  ${l.detail}`).join('\n')}`
          : null,
        item.url || null,
      ]
        .filter(Boolean)
        .join('\n'),
    });
  }
  return true;
};

const ingestGitleaks = () => {
  const doc = readJson(join(OUT_DIR, 'gitleaks.json'));
  if (!doc) return false;
  for (const leak of Array.isArray(doc) ? doc : []) {
    addFinding({
      id: `gitleaks:${leak.RuleID}:${leak.File}:${leak.StartLine}`,
      source: 'gitleaks',
      severity: 'critical',
      title: `Possible committed secret (${leak.RuleID}) in ${leak.File}`,
      // Deliberately no Match/Secret value — the report is written to CI logs,
      // artifacts and a PR body. Never widen the leak.
      detail: `${leak.File}:${leak.StartLine} — commit ${String(leak.Commit || '').slice(0, 12)} by ${leak.Author || 'unknown'}. Value withheld from this report; inspect locally.`,
    });
  }
  return true;
};

// ── The lab's own slash commands ──────────────────────────────────────────
/**
 * This repo ships ~45 slash commands, several of which ARE the remedy for
 * things Dave finds. A finding that says "rotate the credential" is far less
 * useful than one that says "run /rotate" — the lab already built the fix.
 *
 * The mapping is applied deterministically here rather than left to the model,
 * so the report carries the right pointer even on nights when no model runs.
 * Every suggestion is verified against the commands that actually exist in THIS
 * repo, so a generated app missing a command never gets pointed at it.
 */
const readLabCommands = () => {
  const dir = '.claude/commands';
  if (!existsSync(dir)) return {};
  const commands = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
    const name = file.replace(/\.md$/, '');
    const body = readFileSync(join(dir, file), 'utf8');
    // Frontmatter is inconsistent across these files — some carry `name`, some
    // only `description`. The filename is always the invocation, so use it.
    const desc = /^description:\s*(.+)$/m.exec(body)?.[1]?.trim() || '';
    commands[name] = desc.slice(0, 200);
  }
  return commands;
};

/** finding id/source → the lab command that addresses it. */
const remediationFor = (finding) => {
  const { id = '', source = '' } = finding;
  if (source === 'gitleaks') return ['rotate', 'scan-secrets'];
  // A signature check that could not RUN is a tooling fault, not a compromise.
  // Pointing it at /rotate would send someone to rotate credentials over an
  // npm error — the suggestion has to follow the finding, not just its source.
  if (id === 'provenance:signature-check-failed') return [];
  if (source === 'provenance') return ['rotate'];
  if (source === 'upstream') return ['pull-repo-safe', 'pull-security-skills', 'pull-agents'];
  if (source === 'install-script') return ['security-assessment'];
  if (id.startsWith('policy:cooldown') || id.startsWith('policy:engine-strict')) return [];
  if (source === 'npm-audit' || source === 'osv' || source === 'cooldown') {
    // Dave fixes these himself when he can; the deep review is for the rest.
    return finding.autoFixable ? [] : ['security-assessment'];
  }
  return [];
};

const attachRemediations = (available) => {
  for (const f of findings) {
    const suggested = remediationFor(f).filter((c) => c in available);
    if (suggested.length) f.remediationCommands = suggested.map((c) => `/${c}`);
  }
};

// ── Report rendering ───────────────────────────────────────────────────────
const renderMarkdown = (report) => {
  const lines = [];
  const c = report.counts;

  lines.push(`## Dave — nightly security report`);
  lines.push('');
  lines.push(
    report.status === 'clean'
      ? '**All clear.** No actionable findings.'
      : `**${report.findings.length} finding(s)** — ` +
          SEVERITIES.filter((s) => c[s]).map((s) => `${c[s]} ${s}`).join(', '),
  );
  lines.push('');
  lines.push(
    `_Scanners: ${report.scanners.join(', ')} · cooldown ${report.policy.minReleaseAgeDays}d_`,
  );

  if (report.findings.length) {
    lines.push('', '### Findings', '');
    for (const f of report.findings) {
      lines.push(`<details><summary><strong>[${f.severity}]</strong> ${f.title}</summary>`, '');
      if (f.package) lines.push(`- **Package:** \`${f.package}\``);
      lines.push(`- **Source:** ${f.source}`);
      if (f.fixedIn) lines.push(`- **Fixed in:** \`${f.fixedIn}\``);
      lines.push(`- **Auto-fixable:** ${f.autoFixable ? 'yes' : 'no — needs judgement'}`);
      if (f.remediationCommands?.length) {
        lines.push(`- **Lab command:** ${f.remediationCommands.map((c) => `\`${c}\``).join(' then ')}`);
      }
      if (f.detail) lines.push('', '```', f.detail, '```');
      if (f.references?.length) lines.push('', ...f.references.map((r) => `- ${r}`));
      lines.push('', '</details>', '');
    }
  }

  const blocked = report.upgrades.filter((u) => !u.cooldownOk && !u.cooldownExempt);
  const ready = report.upgrades.filter((u) => u.cooldownOk || u.cooldownExempt);
  if (ready.length) {
    lines.push('', '### Upgrade candidates that clear the cooldown', '');
    lines.push('| Package | Current | Target | Age | Why |', '|---|---|---|---|---|');
    for (const u of ready.slice(0, 30)) {
      lines.push(
        `| \`${u.name}\` | ${u.current} | ${u.target} | ${u.publishedDaysAgo ?? '?'}d | ${
          u.securityDriven ? '**advisory**' : 'routine'
        }${u.isMajor ? ' · major' : ''} |`,
      );
    }
  }
  if (blocked.length) {
    lines.push('', '### Held back by the cooldown', '');
    for (const u of blocked.slice(0, 30)) {
      lines.push(`- \`${u.name}\` → ${u.target} (published ${u.publishedDaysAgo ?? '?'} days ago)`);
    }
  }

  if (report.errors.length) {
    lines.push('', '### Scan errors', '', ...report.errors.map((e) => `- ${e}`));
  }

  return lines.join('\n');
};

// ── Main ───────────────────────────────────────────────────────────────────
const main = async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  registryCache = readJson(registryCachePath) || {};

  const scanners = [];

  log('› npm audit');
  const { advisoryPackages, advisoryIds } = checkAudit();
  scanners.push('npm-audit');

  log('› osv.dev');
  const osv = await checkOsv(advisoryIds);
  if (!osv.skipped) scanners.push('osv');

  log(CHEAP ? '› npm outdated + cooldown (skipped — cheap tier)' : '› npm outdated + cooldown');
  const upgrades = await checkOutdated(advisoryPackages);
  if (!CHEAP) scanners.push('outdated');

  log('› install-script allowlist');
  const installScripts = checkInstallScripts();

  log('› registry signatures');
  const signatures = checkSignatures();
  if (!signatures.skipped) scanners.push('npm-audit-signatures');

  log('› upstream drift');
  const upstream = checkUpstream();
  if (!upstream.skipped) scanners.push('upstream');

  log('› policy drift');
  checkPolicyDrift();
  scanners.push('policy');

  if (ingestOsv()) scanners.push('osv-scanner');
  if (ingestZizmor()) scanners.push('zizmor');
  if (ingestGitleaks()) scanners.push('gitleaks');

  // A total registry outage means the cooldown — the highest-value control
  // here — could not run at all, so the scan is blind rather than clean. One
  // package failing to resolve is noted in `errors` and nothing more. This has
  // to be settled BEFORE the report is built, or `status` and the exit code
  // would disagree with each other.
  if (registryStats.attempted > 0 && registryStats.failed === registryStats.attempted) {
    degraded.add('registry');
  }

  const labCommands = readLabCommands();
  attachRemediations(labCommands);

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) counts[f.severity] += 1;

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    repo: process.env.GITHUB_REPOSITORY || null,
    commit: process.env.GITHUB_SHA || run('git', ['rev-parse', 'HEAD']).stdout.trim() || null,
    policy: { minReleaseAgeDays: COOLDOWN_DAYS },
    // Which tier produced this report. A cheap-tier `clean` is a narrower claim
    // than a full-tier one — it means "nothing found in the checks that ran",
    // and the checks needing an installed tree were not among them. Anything
    // consuming report.json has to be able to tell those two apart.
    tier: CHEAP ? 'cheap' : 'full',
    scanners,
    // "clean" is a claim that we looked and found nothing. If a scanner failed
    // to reach a verdict we did not look, and the honest answer is `unknown`.
    status: findings.length ? 'findings' : degraded.size ? 'unknown' : 'clean',
    degraded: [...degraded],
    // Stable identity for "this exact set of problems". The nightly job embeds
    // it in the PR/issue it opens, so a subsequent run that finds the same
    // things recognises its own earlier output and stays quiet instead of
    // re-triaging and re-pinging Slack every night until someone merges.
    fingerprint: createHash('sha256')
      .update(findings.map((f) => f.id).sort().join('\n'))
      .digest('hex')
      .slice(0, 16),
    counts,
    highestSeverity: findings.length ? findings[0].severity : null,
    findings,
    upgrades,
    installScripts,
    signatures,
    osv,
    upstream,
    // The commands this repo actually ships, so triage can point at real ones
    // instead of inventing plausible-sounding names.
    labCommands,
    errors,
  };

  writeFileSync(join(OUT_DIR, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(OUT_DIR, 'report.md'), `${renderMarkdown(report)}\n`);
  writeFileSync(registryCachePath, `${JSON.stringify(registryCache)}\n`);

  if (!QUIET) {
    console.log(renderMarkdown(report));
    console.error(`\nWrote ${join(OUT_DIR, 'report.json')}`);
  }

  // A scan that couldn't actually see anything must not be reported as clean.
  //
  // This guard used to read `scanners.length <= 1`, which could never be true:
  // 'npm-audit' and 'policy' are both pushed unconditionally, so the array is
  // always at least 2 long by the time we get here and the whole condition was
  // dead code. A night where OSV was down, the registry was unreachable and
  // npm audit returned garbage exited 0 and posted a green all-clear.
  //
  // The question is not "how many scanners ran" but "did any scanner fail to
  // reach a verdict", which is what `degraded` tracks. A total registry outage
  // counts — the cooldown is the highest-value control here and it cannot run
  // without publish dates. One package failing to resolve does not; that is
  // recorded in `errors` and nothing more.
  if (!findings.length && degraded.size) {
    console.error(
      `\nScan is UNKNOWN, not clean — these did not reach a verdict: ${[...degraded].join(', ')}`,
    );
    process.exit(2);
  }
  process.exit(findings.length ? 1 : 0);
};

main().catch((err) => {
  console.error(`dave-scan failed: ${err?.stack || err}`);
  process.exit(2);
});
