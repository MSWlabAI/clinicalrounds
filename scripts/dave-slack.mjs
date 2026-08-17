#!/usr/bin/env node
/**
 * dave-slack — post Dave's nightly verdict to the lab Slack channel.
 * =================================================================
 *
 * Uses the same incoming-webhook + Block Kit approach as the upstream-sync
 * workflow, but as a script so that the nightly job, a local `/dave` run and
 * the self-test all send *identically shaped* messages. If a message ever looks
 * wrong in Slack, there is exactly one place to fix it.
 *
 * The Slack post is deliberately made by the workflow, never by the agent. The
 * agent reads untrusted advisory text; giving it an outbound HTTP call would
 * hand it an exfiltration channel. It produces a report; the workflow speaks.
 *
 * Usage
 * -----
 *   node scripts/dave-slack.mjs --status clean|findings|blocked|error|selftest \
 *        [--report .dave/out/report.json] [--pr-url URL] [--run-url URL] [--dry-run]
 *
 * Env
 * ---
 *   SLACK_WEBHOOK_URL   required unless --dry-run (missing = skip, not fail)
 *   DAVE_SLACK_QUIET_GREEN=1   suppress the nightly all-clear ping, still report problems
 */

import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const STATUS = String(flag('status', 'error'));
const REPORT_PATH = String(flag('report', '.dave/out/report.json'));
const PR_URL = flag('pr-url', null);
const RUN_URL = flag('run-url', process.env.DAVE_RUN_URL || null);
const DRY_RUN = Boolean(flag('dry-run', false));
const REPO = process.env.GITHUB_REPOSITORY || 'this repo';

let report = null;
try {
  report = JSON.parse(readFileSync(REPORT_PATH, 'utf8'));
} catch {
  /* a report is optional — e.g. for --status error or selftest */
}

const counts = report?.counts || {};
const severe = (counts.critical || 0) + (counts.high || 0);
const total = report?.findings?.length || 0;

// ── Message shape per status ───────────────────────────────────────────────
const shape = () => {
  switch (STATUS) {
    case 'clean':
      return {
        emoji: ':large_green_circle:',
        headline: `*Dave — ${REPO}:* all clear. No actionable security findings.`,
        context: report
          ? `Scanners: ${report.scanners.join(', ')} · cooldown ${report.policy.minReleaseAgeDays}d`
          : null,
      };
    // Weekly "still here" post when findings are unchanged. Deliberately low
    // key: it is a liveness signal, not an alert. Its real job is to make the
    // ABSENCE of a post meaningful — without it, a channel that has been quiet
    // for a week could equally mean nothing changed or Dave stopped running,
    // and there is no way to tell those apart from the outside.
    case 'heartbeat':
      return {
        emoji: ':white_circle:',
        headline:
          `*Dave — ${REPO}:* still here. ${total} open finding(s), unchanged` +
          (severe ? ` — *${severe} critical/high*` : '') +
          '. Nothing new since the last report.',
        context: [
          report ? `Tracked as ${report.fingerprint}` : null,
          report ? `Scanners: ${report.scanners.join(', ')}` : null,
          'Weekly heartbeat — a missing one means the nightly run stopped.',
        ]
          .filter(Boolean)
          .join(' · '),
      };
    case 'findings':
      return {
        emoji: severe ? ':red_circle:' : ':large_yellow_circle:',
        headline:
          `*Dave — ${REPO}:* ${total} finding(s)` +
          (severe ? ` — *${severe} critical/high*` : '') +
          // Only claim a PR when the link actually is one. Dave files a tracking
          // ISSUE for findings outside his remit, which is the common case —
          // saying "a remediation PR is open" there sends people looking for a
          // diff that was never written.
          (TARGET_IS_PR
            ? '. A remediation PR is open for review.'
            : TARGET_IS_ISSUE
              ? '. Outside his remit — tracking issue filed, needs a human.'
              : '. Needs a human — nothing auto-fixable.'),
        context: summarizeTop(),
      };
    case 'blocked':
      return {
        emoji: ':warning:',
        headline: `*Dave — ${REPO}:* proposed a fix that failed policy verification. Draft PR opened; do not merge without reading it.`,
        context: summarizeTop(),
      };
    case 'selftest':
      return {
        emoji: ':test_tube:',
        headline: `*Dave — ${REPO}:* self-test message. If you can read this, the Slack path works.`,
        context: null,
      };
    default:
      return {
        emoji: ':rotating_light:',
        headline: `*Dave — ${REPO}:* the nightly run itself failed. The absence of findings tonight means nothing.`,
        context: null,
      };
  }
};

/**
 * The four highest-severity findings, DE-DUPLICATED by title.
 *
 * Without the grouping this printed the same sentence four times: a repo with
 * 26 unpinned actions produced "GitHub Actions: unpinned action reference" ×4
 * and nothing else, so the one part of Dave most people actually read said
 * almost nothing. Collapsing repeats and showing the count is the difference
 * between "something is wrong" and "26 of one thing is wrong".
 */
function summarizeTop() {
  if (!report?.findings?.length) return null;

  const groups = new Map();
  for (const f of report.findings) {
    const key = `${f.severity}::${f.title}`;
    const g = groups.get(key);
    if (g) {
      g.count += 1;
    } else {
      groups.set(key, { severity: f.severity, title: f.title, count: 1, id: f.id });
    }
  }

  const lines = [...groups.values()].slice(0, 4).map((g) => {
    // The id carries the location (workflow:unpinned:ci.yml), which is the
    // part that tells you where to look. Only useful when it is not repeated.
    const where = g.count === 1 && g.id ? ` — \`${g.id}\`` : '';
    const times = g.count > 1 ? ` ×${g.count}` : '';
    return `• [${g.severity}] ${g.title}${times}${where}`;
  });

  const shown = [...groups.values()].slice(0, 4).reduce((n, g) => n + g.count, 0);
  const rest = report.findings.length - shown;
  if (rest > 0) lines.push(`• …and ${rest} more`);

  return lines.join('\n').slice(0, 2800);
}

/** A tracking issue is not a pull request, and the message must not claim it is. */
const TARGET_IS_PR = Boolean(PR_URL && /\/pull\/\d+/.test(PR_URL));
const TARGET_IS_ISSUE = Boolean(PR_URL && /\/issues\/\d+/.test(PR_URL));

const main = async () => {
  if (STATUS === 'clean' && process.env.DAVE_SLACK_QUIET_GREEN === '1') {
    console.log('All clear, and DAVE_SLACK_QUIET_GREEN=1 — skipping the Slack ping.');
    return;
  }

  const { emoji, headline, context } = shape();
  const text = `${emoji} ${headline.replace(/\*/g, '')}`;

  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: `${emoji} ${headline}` } }];
  if (context) {
    // Findings go in a section, not a context block. Slack renders context as
    // small grey text, which is the wrong emphasis for the one message someone
    // needs to actually read. The scanner/cooldown footnote stays in context —
    // that genuinely is a footnote.
    // `heartbeat` is a liveness signal about findings a human has already seen,
    // so its context is a footnote too — it must not compete with a real alert.
    blocks.push(
      STATUS === 'clean' || STATUS === 'heartbeat'
        ? { type: 'context', elements: [{ type: 'mrkdwn', text: context }] }
        : { type: 'section', text: { type: 'mrkdwn', text: context } },
    );
  }

  const elements = [];
  if (PR_URL) {
    elements.push({
      type: 'button',
      text: {
        type: 'plain_text',
        // Label the button after whatever it actually opens.
        text: TARGET_IS_PR ? 'Review the PR' : TARGET_IS_ISSUE ? 'Open the issue' : 'Open',
        emoji: true,
      },
      url: PR_URL,
      style: severe ? 'danger' : 'primary',
    });
  }
  if (RUN_URL) {
    elements.push({
      type: 'button',
      text: { type: 'plain_text', text: 'Workflow run', emoji: true },
      url: RUN_URL,
    });
  }
  if (elements.length) blocks.push({ type: 'actions', elements });

  const payload = { text, blocks };

  if (DRY_RUN) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  const webhook = process.env.SLACK_WEBHOOK_URL;
  if (!webhook) {
    // A missing webhook must never fail the security run — the findings still
    // land in the PR and the job summary.
    console.warn('SLACK_WEBHOOK_URL not set — skipping Slack notification.');
    console.log(JSON.stringify(payload));
    return;
  }

  const res = await fetch(webhook, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    console.warn(`Slack POST failed: HTTP ${res.status} ${await res.text()}`);
    return;
  }
  console.log('Slack notified.');
};

main().catch((err) => {
  console.warn(`dave-slack failed (non-fatal): ${err?.message || err}`);
});
