#!/usr/bin/env node
/**
 * dave-dashboard — render Dave's current state as a standalone HTML page.
 * ======================================================================
 *
 * Slack is a feed: it tells you what *happened*. A dashboard tells you what
 * *is*. Both matter, and they fail differently — a feed you were not watching
 * is indistinguishable from a feed with nothing in it.
 *
 * Reads the report the scan already produced, plus (optionally) the nightly run
 * history from the GitHub API, and writes one self-contained file: no external
 * CSS, no fonts, no scripts, so it can be opened from disk, committed, attached
 * to a job summary, or published as-is.
 *
 * Usage
 * -----
 *   npm run dave                                   # produce .dave/out/report.json
 *   node scripts/dave-dashboard.mjs                # → .dave/out/dashboard.html
 *   node scripts/dave-dashboard.mjs --out path.html
 *
 * Run history is included when a token is available (GH_TOKEN or GITHUB_TOKEN)
 * and GITHUB_REPOSITORY is set, or --repo owner/name is passed. Without it the
 * page still renders the current scan and says the history is unavailable —
 * rather than silently showing an empty timeline, which would read as "he never
 * ran".
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};

const REPORT = resolve(flag('report', '.dave/out/report.json'));
const OUT = resolve(flag('out', '.dave/out/dashboard.html'));
const REPO = flag('repo', process.env.GITHUB_REPOSITORY || '');
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

if (!existsSync(REPORT)) {
  console.error(`dave-dashboard: no report at ${REPORT}\nRun \`npm run dave\` first.`);
  process.exit(2);
}
const report = JSON.parse(readFileSync(REPORT, 'utf8'));

// ── Run history (optional) ─────────────────────────────────────────────────
const fetchRuns = async () => {
  // Pre-fetched history, for callers that already have it or cannot reach the
  // API (a sandbox behind a proxy, an air-gapped runner). Same shape the API
  // returns, reduced to what the page renders.
  const file = flag('runs');
  if (file && existsSync(resolve(file))) {
    try {
      return { runs: JSON.parse(readFileSync(resolve(file), 'utf8')), reason: null };
    } catch (err) {
      return { runs: null, reason: `could not read --runs file: ${err.message}` };
    }
  }
  if (!REPO || !TOKEN) return { runs: null, reason: 'no GitHub token or repository in scope' };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/actions/workflows/dave-nightly.yml/runs?per_page=14`,
      { headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json' } },
    );
    if (!res.ok) return { runs: null, reason: `GitHub API returned ${res.status}` };
    const body = await res.json();
    return {
      runs: (body.workflow_runs || []).map((r) => ({
        at: r.created_at,
        event: r.event,
        conclusion: r.conclusion,
        url: r.html_url,
      })),
      reason: null,
    };
  } catch (err) {
    return { runs: null, reason: err.message };
  }
};

// ── Rendering ──────────────────────────────────────────────────────────────
const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

const SEV = ['critical', 'high', 'moderate', 'low', 'info'];

/** The verdict, phrased so "unknown" can never be mistaken for "clean". */
const verdict = () => {
  if (report.status === 'clean') {
    return { tone: 'ok', label: 'All clear', line: 'Scanners ran and found nothing actionable.' };
  }
  if (report.status === 'unknown') {
    return {
      tone: 'unknown',
      label: 'Unknown',
      line: `A scanner could not reach a verdict (${(report.degraded || []).join(', ')}). Tonight's silence means nothing.`,
    };
  }
  const severe = (report.counts?.critical || 0) + (report.counts?.high || 0);
  return {
    tone: severe ? 'crit' : 'warn',
    label: severe ? `${severe} critical/high` : `${report.findings.length} findings`,
    line: severe
      ? 'Findings that need attention now.'
      : 'Findings to work through. Nothing critical or high.',
  };
};

const main = async () => {
  const { runs, reason } = await fetchRuns();
  const v = verdict();
  const counts = report.counts || {};

  const bySource = {};
  for (const f of report.findings || []) bySource[f.source] = (bySource[f.source] || 0) + 1;

  const html = `<title>Dave — ${esc(report.repo || REPO || 'this app')}</title>
<style>
:root{--bg:#0E1417;--surf:#151D21;--surf2:#1C262B;--rule:#26333A;--ink:#DFE9EC;--dim:#8FA3AA;--faint:#63767E;
--ok:#4CB782;--warn:#E9A33C;--crit:#DF5B4F;--unknown:#8FA3AA;
--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
@media (prefers-color-scheme:light){:root:not([data-theme="dark"]){--bg:#F6F8F8;--surf:#fff;--surf2:#EDF2F2;--rule:#D6E0E2;--ink:#101A1D;--dim:#56686F;--faint:#7C8D93;--ok:#217650;--warn:#A76A11;--crit:#B23A2E;--unknown:#56686F}}
:root[data-theme="light"]{--bg:#F6F8F8;--surf:#fff;--surf2:#EDF2F2;--rule:#D6E0E2;--ink:#101A1D;--dim:#56686F;--faint:#7C8D93;--ok:#217650;--warn:#A76A11;--crit:#B23A2E;--unknown:#56686F}
body{background:var(--bg);color:var(--ink);font-family:var(--sans);margin:0;line-height:1.6}
.wrap{max-width:820px;margin:0 auto;padding:48px 24px 80px}
h1{font-family:var(--mono);font-size:clamp(26px,5vw,38px);letter-spacing:-.02em;margin:0 0 6px}
.sub{color:var(--dim);margin:0 0 36px;font-size:15px}
.lbl{font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--faint);display:flex;align-items:center;gap:14px;margin:40px 0 16px}
.lbl::after{content:"";flex:1;height:1px;background:var(--rule)}
.verdict{border:1px solid var(--rule);border-left:3px solid var(--tone);background:var(--surf);border-radius:4px;padding:20px 22px}
.verdict .big{font-family:var(--mono);font-size:20px;font-weight:700;color:var(--tone)}
.verdict p{margin:6px 0 0;color:var(--dim);font-size:15px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(104px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:4px;overflow:hidden;margin-top:16px}
.cell{background:var(--surf);padding:14px 16px}
.cell .n{font-family:var(--mono);font-size:24px;font-weight:700;font-variant-numeric:tabular-nums}
.cell .k{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint)}
table{border-collapse:collapse;width:100%;font-size:14.5px}
.scroll{overflow-x:auto;border:1px solid var(--rule);border-radius:4px}
th,td{text-align:left;padding:10px 14px;border-bottom:1px solid var(--rule)}
th{font-family:var(--mono);font-size:10px;letter-spacing:.12em;text-transform:uppercase;color:var(--faint);background:var(--surf2)}
td{color:var(--dim)}td:first-child{color:var(--ink)}
tr:last-child td{border-bottom:none}
.pill{font-family:var(--mono);font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;padding:2px 7px;border-radius:3px;white-space:nowrap}
.s-critical,.s-high{background:var(--crit);color:#fff}.s-moderate{background:var(--warn);color:#1a1205}
.s-low,.s-info{background:var(--surf2);color:var(--dim)}
.runs{display:flex;gap:5px;flex-wrap:wrap;margin-bottom:10px}
.run{width:26px;height:34px;border-radius:3px;display:block}
.r-success{background:var(--ok)}.r-failure{background:var(--crit)}.r-other{background:var(--surf2);border:1px solid var(--rule)}
code{font-family:var(--mono);font-size:.87em;background:var(--surf2);padding:.08em .36em;border-radius:3px}
.note{color:var(--faint);font-size:13.5px;margin-top:8px}
a{color:var(--warn)}
</style>
<div class="wrap">
<h1>Dave</h1>
<p class="sub">${esc(report.repo || REPO || 'this app')} · scanned ${esc(report.generatedAt)}</p>

<div class="verdict" style="--tone:var(--${v.tone})">
  <div class="big">${esc(v.label)}</div>
  <p>${esc(v.line)}</p>
</div>

<div class="grid">
${SEV.map((s) => `  <div class="cell"><div class="n" style="color:var(--${s === 'critical' || s === 'high' ? 'crit' : s === 'moderate' ? 'warn' : 'faint'})">${counts[s] || 0}</div><div class="k">${s}</div></div>`).join('\n')}
</div>
<p class="note">Scanners that contributed: ${esc((report.scanners || []).join(', ') || 'none')}${
    (report.degraded || []).length
      ? ` · <strong>could not reach a verdict: ${esc(report.degraded.join(', '))}</strong>`
      : ''
  } · cooldown ${esc(report.policy?.minReleaseAgeDays)}d · tracked as <code>${esc(report.fingerprint)}</code></p>

<p class="lbl">Nightly runs</p>
${
  runs
    ? `<div class="runs">${runs
        .slice()
        .reverse()
        .map(
          (r) =>
            `<a class="run ${r.conclusion === 'success' ? 'r-success' : r.conclusion === 'failure' ? 'r-failure' : 'r-other'}" href="${esc(r.url)}" title="${esc(r.at)} · ${esc(r.event)} · ${esc(r.conclusion)}"></a>`,
        )
        .join('')}</div>
<p class="note">Oldest to newest, ${runs.length} run(s). Green ran and reported; red failed to complete.</p>`
    : `<p class="note">Run history unavailable — ${esc(reason)}. This is not "he never ran": the page simply could not ask.</p>`
}

<p class="lbl">Open findings</p>
${
  (report.findings || []).length
    ? `<div class="scroll"><table><thead><tr><th>Severity</th><th>Finding</th><th>Fix with</th></tr></thead><tbody>
${report.findings
  .map(
    (f) =>
      `<tr><td><span class="pill s-${esc(f.severity)}">${esc(f.severity)}</span></td><td>${esc(f.title)}</td><td>${(f.remediationCommands || []).map((c) => `<code>${esc(c)}</code>`).join(' ') || '—'}</td></tr>`,
  )
  .join('\n')}
</tbody></table></div>`
    : '<p class="note">None.</p>'
}

<p class="lbl">By source</p>
<div class="scroll"><table><tbody>
${
  Object.entries(bySource)
    .sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `<tr><td>${esc(s)}</td><td style="font-family:var(--mono)">${n}</td></tr>`)
    .join('\n') || '<tr><td>—</td><td>0</td></tr>'
}
</tbody></table></div>

<p class="note" style="margin-top:36px">Generated by <code>scripts/dave-dashboard.mjs</code> from <code>${esc(REPORT.split('/').slice(-3).join('/'))}</code>. This is a snapshot of one scan, not a live view — regenerate with <code>npm run dave &amp;&amp; npm run dave:dashboard</code>.</p>
</div>
`;

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, html);
  console.log(`Wrote ${OUT}`);
  if (!runs) console.warn(`Run history omitted: ${reason}`);
};

main().catch((err) => {
  console.error(`dave-dashboard failed: ${err?.stack || err}`);
  process.exit(2);
});
