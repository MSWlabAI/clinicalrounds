/**
 * dave-scan-lib — pure helpers shared by dave-scan and dave-verify.
 * ================================================================
 *
 * Deliberately a separate, side-effect-free module. It is imported by BOTH the
 * scanner (which *reports* an available major) and the verifier (which *rejects*
 * one Dave tried to perform), so the two can never disagree about what counts as
 * "framework tier". Being pure, it is unit-testable without spawning a process,
 * a registry, or a node_modules — which is why this logic lives here rather than
 * behind an `import.meta` guard on the scanner's entry point, where a broken
 * guard would silently switch a security control off.
 *
 * If this file goes missing, both scripts fail to import and their jobs error
 * out (exit 2 → "unknown", never "clean"). Loud, not silent — by design.
 */

/**
 * Dependencies where a MAJOR bump is a migration, not a version bump: it edits
 * app source far beyond Dave's package.json/lockfile/.npmrc remit. Kept small
 * and named on purpose — this is the list the verifier refuses to let Dave bump
 * across a major, so every addition widens what he is forbidden to touch.
 * A leaf utility going 2.x→3.x is dependabot's job, not this.
 */
export const FRAMEWORK_TIER = new Set([
  'next',
  'react',
  'react-dom',
  'convex',
  '@clerk/nextjs',
  '@clerk/backend',
  '@clerk/themes',
]);

const majorOf = (v) => {
  const m = /^\D*(\d+)/.exec(String(v ?? ''));
  return m ? m[1] : null;
};

/**
 * The event names in a workflow's `on:` block.
 *
 * GitHub accepts three spellings and they are all equally live:
 *
 *   on: pull_request_target          ← scalar
 *   on: [push, pull_request_target]  ← sequence
 *   on:                              ← mapping
 *     pull_request_target:
 *
 * Matching only the mapping form — as a bare /^\s*pull_request_target\s*:/m
 * does — silently misses the other two, which is how the single most dangerous
 * trigger in Actions can sit in a repo with a green scanner over it.
 *
 * Deliberately anchored to the `on:` block rather than scanning the whole file,
 * so `if: github.event_name == 'pull_request_target'` — a guard, not a trigger —
 * does not read as a finding. YAML 1.1 folds bare `on` to a boolean, so the key
 * is often written quoted; both forms are accepted here.
 *
 * A hand-rolled parser rather than a YAML dependency on purpose: Dave is
 * dependency-free by design so his senses cannot themselves become the supply-
 * chain problem he exists to catch.
 */
export const workflowTriggers = (body = '') => {
  const lines = String(body).split(/\r?\n/);
  const found = new Set();

  const onLine = lines.findIndex((l) => /^(?:on|'on'|"on")\s*:/.test(l));
  if (onLine === -1) return found;

  const rest = lines[onLine].replace(/^(?:on|'on'|"on")\s*:/, '').replace(/#.*$/, '').trim();

  if (rest.startsWith('[')) {
    // Sequence form, possibly spanning lines until the closing bracket.
    let buf = rest;
    for (let i = onLine + 1; !buf.includes(']') && i < lines.length; i += 1) buf += lines[i];
    for (const raw of buf.slice(buf.indexOf('[') + 1, buf.indexOf(']')).split(',')) {
      const name = raw.trim().replace(/^['"]|['"]$/g, '');
      if (name) found.add(name);
    }
    return found;
  }

  if (rest) {
    // Scalar form. `on: push` — one event, no punctuation.
    const name = rest.replace(/^['"]|['"]$/g, '');
    if (/^[a-z_]+$/.test(name)) found.add(name);
    return found;
  }

  // Mapping form: take the keys at the first indent level below `on:`, stopping
  // at the next top-level key (`jobs:`, `permissions:`, …).
  let indent = null;
  for (let i = onLine + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const lead = /^(\s*)/.exec(line)[1].length;
    if (lead === 0) break;
    if (indent === null) indent = lead;
    if (lead > indent) continue; // nested filter, e.g. `branches:`
    const key = /^\s*([a-z_]+)\s*:/.exec(line);
    if (key) found.add(key[1]);
  }
  return found;
};

/**
 * Advisory-only findings for framework-tier deps with an available major.
 *
 * Pure. `upgrades` is the array checkOutdated already builds (each entry has
 * name/current/latest/target/isMajor/cooldownOk/cooldownExempt). `importCounter`
 * supplies the blast-radius estimate — injected so the caller owns the IO and
 * tests can stub it. Returns finding objects; it never mutates global state.
 *
 * Dave reports these; he never acts on them. Majors are breaking by definition,
 * and dave-verify rejects a framework-tier major bump even though the bump lives
 * inside his file remit — so this finding cannot become a silent auto-upgrade.
 */
export const frameworkMajorFindings = (upgrades = [], importCounter = () => null) => {
  const out = [];
  for (const u of upgrades) {
    if (!u || !FRAMEWORK_TIER.has(u.name) || u.isMajor !== true) continue;
    // Don't nag about a major that has not settled past the supply-chain
    // cooldown, unless an advisory forces the issue.
    if (!u.cooldownOk && !u.cooldownExempt) continue;

    const target = u.latest ?? u.target;
    const from = majorOf(u.current);
    const to = majorOf(target);
    if (!to) continue;

    const sites = importCounter(u.name);
    out.push({
      id: `framework-major:${u.name}:${to}`,
      source: 'framework-major',
      severity: 'low',
      package: u.name,
      title: `${u.name} ${from ?? '?'}.x → ${to}.x is available — a major framework upgrade`,
      detail:
        `A new major of ${u.name} is available (${u.current} → ${target}). Majors are ` +
        'breaking by definition, so Dave flags this and never performs it — the verifier ' +
        'rejects a framework-tier major bump even inside his file remit. ' +
        (typeof sites === 'number' ? `Blast radius: ${sites} tracked file(s) import ${u.name}. ` : '') +
        'Plan the migration deliberately, in a human-reviewed branch — not as a nightly fix.',
    });
  }
  return out;
};
