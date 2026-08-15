#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const WEEKLY_TITLE_RE = /^Weekly feature review \d{4}-\d{2}-\d{2}$/i;
const TRACKING_BODY_RE = /Tracking issue for the automated weekly feature-review pass/i;
const SUMMARY_COMMENT_RE = /Weekly feature-review summary/i;

function parseArgs(argv) {
  const args = {
    apply: false,
    issueNumber: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--apply') {
      args.apply = true;
      continue;
    }

    if (token === '--issue') {
      const value = argv[i + 1] ?? '';
      if (!/^\d+$/.test(value)) {
        throw new Error('Expected numeric value after --issue');
      }
      args.issueNumber = Number(value);
      i += 1;
      continue;
    }

    if (token.startsWith('--issue=')) {
      const value = token.slice('--issue='.length);
      if (!/^\d+$/.test(value)) {
        throw new Error('Expected numeric value in --issue=<number>');
      }
      args.issueNumber = Number(value);
      continue;
    }

    if (token === '--help' || token === '-h') {
      printHelp();
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  return args;
}

function printHelp() {
  console.log(`Usage: node ./scripts/weekly-review-hygiene.mjs [--issue <number>] [--apply]

Scans open weekly feature-review tracking issues (labelled bot-proposed + meta)
and closes those that already contain a weekly summary comment.

Options:
  --issue <number>  Only evaluate a single issue number.
  --apply           Perform close/comment actions (default is dry-run).
  -h, --help        Show help.
`);
}

function runGh(args) {
  try {
    return execFileSync('gh', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const stderr = error?.stderr?.toString?.() ?? '';
    const stdout = error?.stdout?.toString?.() ?? '';
    throw new Error(`gh ${args.join(' ')} failed\n${stdout}\n${stderr}`.trim());
  }
}

function getCandidateIssues(issueNumber) {
  if (issueNumber !== null) {
    const issue = JSON.parse(runGh(['issue', 'view', String(issueNumber), '--json', 'number,title,body,url,state,labels']));
    return [issue];
  }

  return JSON.parse(
    runGh([
      'issue',
      'list',
      '--state',
      'open',
      '--label',
      'bot-proposed',
      '--label',
      'meta',
      '--limit',
      '200',
      '--json',
      'number,title,body,url,state,labels',
    ]),
  );
}

function getIssueComments(issueNumber) {
  const payload = JSON.parse(runGh(['issue', 'view', String(issueNumber), '--json', 'comments']));
  return payload.comments ?? [];
}

function qualifiesForClose(issue) {
  if (issue.state !== 'OPEN') return false;
  if (!WEEKLY_TITLE_RE.test(issue.title ?? '')) return false;
  if (!TRACKING_BODY_RE.test(issue.body ?? '')) return false;

  const comments = getIssueComments(issue.number);
  return comments.some((comment) => SUMMARY_COMMENT_RE.test(comment.body ?? ''));
}

function closeIssue(issueNumber, issueUrl) {
  const dir = mkdtempSync(join(tmpdir(), 'regarded-weekly-review-'));
  const bodyFile = join(dir, 'close-comment.md');

  try {
    writeFileSync(
      bodyFile,
      [
        'Weekly feature-review summary has been posted and follow-up items were filed.',
        '',
        'Closing this tracking issue as complete via automation hygiene pass.',
      ].join('\n'),
      'utf8',
    );

    runGh(['issue', 'comment', String(issueNumber), '--body-file', bodyFile]);
    runGh(['issue', 'close', String(issueNumber), '--reason', 'completed']);
    console.log(`CLOSED #${issueNumber} ${issueUrl}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const { apply, issueNumber } = parseArgs(process.argv.slice(2));

  const issues = getCandidateIssues(issueNumber);
  if (issues.length === 0) {
    console.log('No matching open weekly-review issues found.');
    return;
  }

  let candidates = 0;
  for (const issue of issues) {
    if (!qualifiesForClose(issue)) {
      console.log(`SKIP #${issue.number} ${issue.url}`);
      continue;
    }

    candidates += 1;
    if (!apply) {
      console.log(`DRY-RUN CLOSE #${issue.number} ${issue.url}`);
      continue;
    }

    closeIssue(issue.number, issue.url);
  }

  if (candidates === 0) {
    console.log('No close candidates found after evaluation.');
  }
}

main();
