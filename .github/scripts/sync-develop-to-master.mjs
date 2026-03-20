#!/usr/bin/env node

import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

function run(cmd, options = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...options,
    }).trim();
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout) : '';
    const stderr = error.stderr ? String(error.stderr) : '';
    console.error(`\nCommand failed: ${cmd}`);
    if (stdout) console.error(`\nSTDOUT:\n${stdout}`);
    if (stderr) console.error(`\nSTDERR:\n${stderr}`);
    process.exit(1);
  }
}

function tryRun(cmd, options = {}) {
  try {
    return {
      ok: true,
      output: execSync(cmd, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        ...options,
      }).trim(),
    };
  } catch (error) {
    return {
      ok: false,
      output: '',
      stdout: error.stdout ? String(error.stdout) : '',
      stderr: error.stderr ? String(error.stderr) : '',
    };
  }
}

function runGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  if (result.status !== 0) {
    const stdout = result.stdout ? String(result.stdout) : '';
    const stderr = result.stderr ? String(result.stderr) : '';

    console.error(`\nGitHub CLI command failed: gh ${args.join(' ')}`);
    if (stdout) console.error(`\nSTDOUT:\n${stdout}`);
    if (stderr) console.error(`\nSTDERR:\n${stderr}`);
    process.exit(1);
  }

  return (result.stdout || '').trim();
}

function tryGh(args) {
  const result = spawnSync('gh', args, {
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: process.env,
  });

  return {
    ok: result.status === 0,
    output: (result.stdout || '').trim(),
    stdout: result.stdout ? String(result.stdout) : '',
    stderr: result.stderr ? String(result.stderr) : '',
  };
}

function validateEnv() {
  const required = ['GITHUB_REPOSITORY', 'GITHUB_TOKEN'];
  const missing = required.filter((name) => !process.env[name]);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
}

function ensureGitHubCli() {
  const result = tryRun('gh --version');
  if (!result.ok) {
    console.error('GitHub CLI (gh) is not available on this runner.');
    process.exit(1);
  }
}

function ensureFileExists(filePath, defaultContent = '') {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, 'utf-8');
  }
}

function getFormattedDate() {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}_${mm}_${dd}`;
}

function getDisplayDate() {
  return getFormattedDate().replace(/_/g, '-');
}

function sanitizeBranchName(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9/_]/g, '')
    .replace(/\/+/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isIgnoredTitle(title = '') {
  const normalized = title.trim().toLowerCase();
  return (
    normalized === 'sync master back to develop' ||
    normalized.startsWith('sync master back to develop') ||
    normalized.startsWith('release ') ||
    normalized.startsWith('release:')
  );
}

function shouldIncludePullRequest(pr) {
  if (!pr) return false;

  const title = pr.title || '';
  const headRefName =
    pr.headRefName ||
    (pr.head && pr.head.ref) ||
    '';

  const baseRefName =
    pr.baseRefName ||
    (pr.base && pr.base.ref) ||
    '';

  if (!title) return false;
  if (isIgnoredTitle(title)) return false;
  if (headRefName.startsWith('sync/master_to_develop_')) return false;
  if (headRefName.startsWith('release/deploy_') && baseRefName === 'master') return false;

  return true;
}

function normalizeAssignees(rawAssignees) {
  if (!Array.isArray(rawAssignees)) return [];

  return rawAssignees
    .map((assignee) => {
      if (!assignee) return null;
      if (typeof assignee === 'string') return assignee.trim() || null;
      if (assignee.login) return String(assignee.login).trim() || null;
      if (assignee.name) return String(assignee.name).trim() || null;
      return null;
    })
    .filter(Boolean);
}

function getNextReleaseSequence(date) {
  let max = 0;
  const branchRegex = new RegExp(`^release/deploy_${escapeRegExp(date)}_(\\d+)$`);
  const tagRegex = new RegExp(`^v${date.replace(/_/g, '\\.')}\\.(\\d+)$`);

  const prResult = tryGh([
    'pr',
    'list',
    '--base', 'master',
    '--state', 'all',
    '--limit', '200',
    '--json', 'headRefName',
  ]);

  if (prResult.ok) {
    try {
      const prs = JSON.parse(prResult.output || '[]');
      for (const pr of prs) {
        const ref = pr.headRefName || '';
        const match = ref.match(branchRegex);
        if (match) {
          const value = parseInt(match[1], 10);
          if (!Number.isNaN(value) && value > max) {
            max = value;
          }
        }
      }
    } catch {
      // ignore and continue
    }
  }

  const tagsResult = tryRun('git tag --list');
  if (tagsResult.ok && tagsResult.output) {
    for (const tag of tagsResult.output.split('\n').map((x) => x.trim()).filter(Boolean)) {
      const match = tag.match(tagRegex);
      if (match) {
        const value = parseInt(match[1], 10);
        if (!Number.isNaN(value) && value > max) {
          max = value;
        }
      }
    }
  }

  return max + 1;
}

function getNextReleaseBranch() {
  const date = getFormattedDate();
  const sequence = getNextReleaseSequence(date);
  return sanitizeBranchName(`release/deploy_${date}_${sequence}`);
}

function createReleaseBranchFromMaster() {
  const candidate = getNextReleaseBranch();
  console.log(`Using release branch: ${candidate}`);

  const first = tryRun(`git checkout -b ${candidate} origin/master`);
  if (first.ok) return candidate;

  console.warn(`Branch creation failed for ${candidate}. Retrying once...`);

  const retryCandidate = getNextReleaseBranch();
  const retry = tryRun(`git checkout -b ${retryCandidate} origin/master`);

  if (!retry.ok) {
    console.error('Unable to create release branch after retry.');
    if (retry.stdout) console.error(`\nSTDOUT:\n${retry.stdout}`);
    if (retry.stderr) console.error(`\nSTDERR:\n${retry.stderr}`);
    process.exit(1);
  }

  console.log(`Using release branch after retry: ${retryCandidate}`);
  return retryCandidate;
}

function mergeDevelopIntoReleaseBranch() {
  const mergeResult = tryRun('git merge --no-edit origin/develop');

  if (mergeResult.ok) {
    console.log('Successfully merged develop into release branch.');
    return;
  }

  console.error('Merge conflict detected while merging develop into the release branch.');
  if (mergeResult.stdout) console.error(`\nSTDOUT:\n${mergeResult.stdout}`);
  if (mergeResult.stderr) console.error(`\nSTDERR:\n${mergeResult.stderr}`);
  process.exit(1);
}

function getTagFromReleaseBranch(releaseBranch) {
  const match = releaseBranch.match(/^release\/deploy_(\d{4})_(\d{2})_(\d{2})_(\d+)$/);
  if (!match) {
    return `v${getFormattedDate().replace(/_/g, '.')}.1`;
  }

  const [, yyyy, mm, dd, seq] = match;
  return `v${yyyy}.${mm}.${dd}.${seq}`;
}

function getDevelopOnlyCommits() {
  const raw = tryRun('git log origin/master..origin/develop --pretty=format:"%H"');
  if (!raw.ok || !raw.output) return [];

  return raw.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function enrichPullRequestDetails(repo, prNumber) {
  const result = tryGh([
    'pr',
    'view',
    String(prNumber),
    '--repo', repo,
    '--json', 'number,title,url,mergedAt,assignees,headRefName,baseRefName',
  ]);

  if (!result.ok || !result.output) {
    return null;
  }

  try {
    const pr = JSON.parse(result.output);

    return {
      title: pr.title || null,
      number: pr.number || null,
      url: pr.url || null,
      mergedAt: pr.mergedAt || null,
      assignees: normalizeAssignees(pr.assignees),
      headRefName: pr.headRefName || null,
      baseRefName: pr.baseRefName || null,
    };
  } catch {
    return null;
  }
}

function getPullRequestForCommit(repo, sha) {
  const result = tryGh([
    'api',
    '-H', 'Accept: application/vnd.github+json',
    `repos/${repo}/commits/${sha}/pulls`,
  ]);

  if (!result.ok || !result.output) {
    return null;
  }

  let prs;
  try {
    prs = JSON.parse(result.output);
  } catch {
    return null;
  }

  if (!Array.isArray(prs) || prs.length === 0) {
    return null;
  }

  const filtered = prs.filter((pr) => shouldIncludePullRequest(pr));
  const chosen = filtered.find((pr) => pr && pr.merged_at) || filtered[0];

  if (!chosen || !chosen.number) {
    return null;
  }

  const enriched = enrichPullRequestDetails(repo, chosen.number);
  if (enriched && shouldIncludePullRequest(enriched)) {
    return enriched;
  }

  return {
    title: chosen.title || null,
    number: chosen.number || null,
    url: chosen.html_url || null,
    mergedAt: chosen.merged_at || null,
    assignees: normalizeAssignees(chosen.assignees),
    headRefName: chosen.head && chosen.head.ref ? chosen.head.ref : null,
    baseRefName: chosen.base && chosen.base.ref ? chosen.base.ref : null,
  };
}

function getMergedChangesFallbackFromGitLog() {
  const raw = tryRun('git log origin/master..origin/develop --pretty=format:"%s"');
  if (!raw.ok || !raw.output) return [];

  return raw.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((title) => !isIgnoredTitle(title))
    .map((title) => ({
      title,
      number: null,
      url: null,
      mergedAt: null,
      assignees: [],
    }));
}

function sortChangesByMergedAtDesc(changes) {
  return [...changes].sort((a, b) => {
    const aTime = a.mergedAt ? Date.parse(a.mergedAt) : 0;
    const bTime = b.mergedAt ? Date.parse(b.mergedAt) : 0;
    return bTime - aTime;
  });
}

function getMergedChanges() {
  const repo = process.env.GITHUB_REPOSITORY;
  const developOnlyCommits = getDevelopOnlyCommits();

  if (developOnlyCommits.length === 0) {
    return [];
  }

  const mergedChanges = [];
  const seen = new Set();

  for (const sha of developOnlyCommits) {
    const pr = getPullRequestForCommit(repo, sha);

    if (!pr || !pr.number || !pr.title || !pr.url) {
      continue;
    }

    if (!shouldIncludePullRequest(pr)) {
      continue;
    }

    const key = String(pr.number);
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    mergedChanges.push(pr);
  }

  if (mergedChanges.length > 0) {
    return sortChangesByMergedAtDesc(mergedChanges);
  }

  console.warn('Unable to map develop-only commits to user PRs. Falling back to git log subjects.');
  return getMergedChangesFallbackFromGitLog();
}

function formatChangeForMarkdown(change) {
  if (change.number && change.url) {
    return `- ${change.title} ([#${change.number}](${change.url}))`;
  }
  return `- ${change.title}`;
}

function formatDateTime(value) {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().replace('T', ' ').replace('.000Z', ' UTC');
}

function formatAssigneeList(change) {
  if (!change.assignees || change.assignees.length === 0) {
    return 'Unassigned';
  }
  return change.assignees.join(', ');
}

function formatRecentReadmeEntry(change) {
  const prLink = change.number && change.url
    ? `[#${change.number}](${change.url})`
    : '(no PR link)';

  return `- ${change.title} ${prLink} | Assignee: \`${formatAssigneeList(change)}\` | Merged: \`${formatDateTime(change.mergedAt)}\``;
}

function updateChangelog(changes) {
  const filePath = 'CHANGELOG.md';
  ensureFileExists(filePath, '# Changelog\n\n');

  const displayDate = getDisplayDate();
  let existing = fs.readFileSync(filePath, 'utf-8');

  if (!existing.trim()) {
    existing = '# Changelog\n\n';
  }

  const newLines = changes
    .map((change) => formatChangeForMarkdown(change))
    .filter((line, index, arr) => arr.indexOf(line) === index)
    .filter((line) => !existing.includes(line));

  if (newLines.length === 0) {
    return;
  }

  const dateHeader = `## ${displayDate}`;
  const sectionRegex = new RegExp(
    `(^${escapeRegExp(dateHeader)}\\n)([\\s\\S]*?)(?=^## \\d{4}-\\d{2}-\\d{2}\\n|\\Z)`,
    'm'
  );

  if (sectionRegex.test(existing)) {
    existing = existing.replace(sectionRegex, (match, heading, body) => {
      const trimmedBody = body.trimEnd();
      const bodyPrefix = trimmedBody ? `${trimmedBody}\n` : '';
      return `${heading}${bodyPrefix}${newLines.join('\n')}\n\n`;
    });
  } else {
    const headerMatch = existing.match(/^# .*\n+/);
    if (headerMatch) {
      const header = headerMatch[0];
      const rest = existing.slice(header.length).trimStart();
      existing = `${header}${dateHeader}\n${newLines.join('\n')}\n\n${rest ? `${rest}\n` : ''}`;
    } else {
      existing = `# Changelog\n\n${dateHeader}\n${newLines.join('\n')}\n\n${existing}`;
    }
  }

  fs.writeFileSync(filePath, existing, 'utf-8');
}

function updateReadme(changes, releaseTag, releaseBranch) {
  const filePath = 'README.md';
  ensureFileExists(
    filePath,
    '# Project\n\n<!-- RELEASE_START -->\n<!-- RELEASE_END -->\n'
  );

  let readme = fs.readFileSync(filePath, 'utf-8');
  const startMarker = '<!-- RELEASE_START -->';
  const endMarker = '<!-- RELEASE_END -->';

  if (!readme.includes(startMarker) || !readme.includes(endMarker)) {
    readme = `${readme.trimEnd()}\n\n${startMarker}\n${endMarker}\n`;
  }

  const ownerRepo = process.env.GITHUB_REPOSITORY;
  const releaseBadge = `![Latest Release](https://img.shields.io/badge/release-${releaseTag}-green)`;
  const branchBadge = `![Branch](https://img.shields.io/badge/branch-${releaseBranch.replace(/\//g, '%2F')}-orange)`;
  const automationBadge = '![Release Flow](https://img.shields.io/badge/release-automated-blue)';

  const recentChanges = sortChangesByMergedAtDesc(changes).slice(0, 5);
  const recentChangesBlock = recentChanges.length === 0
    ? '- No recent user PRs found for this release.'
    : recentChanges.map((item) => formatRecentReadmeEntry(item)).join('\n');

  const section = [
    '## Latest Release',
    '',
    `${automationBadge} ${releaseBadge} ${branchBadge}`,
    '',
    `- Repository: \`${ownerRepo}\``,
    `- Release Date: \`${getDisplayDate()}\``,
    `- Release Tag: \`${releaseTag}\``,
    `- Release Branch: \`${releaseBranch}\``,
    '- Source Branch: `develop`',
    '- Target Branch: `master`',
    '',
    '### Last 5 Merged User PRs',
    '',
    recentChangesBlock,
  ].join('\n');

  const pattern = new RegExp(
    `${escapeRegExp(startMarker)}[\\s\\S]*?${escapeRegExp(endMarker)}`,
    'm'
  );

  const replacement = `${startMarker}\n${section}\n${endMarker}`;
  const updated = readme.replace(pattern, replacement);

  fs.writeFileSync(filePath, updated, 'utf-8');
}

function hasTrackedFileChanges() {
  const status = run('git status --porcelain');
  return Boolean(status);
}

function commitAndPush(releaseTag, releaseBranch) {
  run('git add CHANGELOG.md README.md');

  if (!hasTrackedFileChanges()) {
    console.log('No documentation changes detected. Skipping commit.');
    return false;
  }

  run(`git commit -m "chore: release ${releaseTag}"`);
  run(`git push -u origin ${releaseBranch}`);
  return true;
}

function getExistingPrNumber(releaseBranch) {
  const result = tryGh([
    'pr',
    'list',
    '--head', releaseBranch,
    '--base', 'master',
    '--state', 'open',
    '--json', 'number',
    '--jq', '.[0].number',
  ]);

  if (!result.ok) return null;
  return result.output || null;
}

function buildPrBody(releaseTag, releaseBranch, changes) {
  const lines = [
    '## Automated Release PR',
    '',
    `- Release Tag: \`${releaseTag}\``,
    `- Release Branch: \`${releaseBranch}\``,
    `- Release Date: \`${getDisplayDate()}\``,
    '- Source Branch: `develop`',
    '- Target Branch: `master`',
    '',
    '### Included User PRs',
  ];

  if (changes.length === 0) {
    lines.push('- No user PR changes detected between develop and master.');
  } else {
    for (const change of changes) {
      lines.push(formatChangeForMarkdown(change));
    }
  }

  return lines.join('\n');
}

function writeTempPrBody(prBody) {
  const tempFile = path.join(
    os.tmpdir(),
    `release-pr-body-${Date.now()}-${Math.random().toString(36).slice(2)}.md`
  );
  fs.writeFileSync(tempFile, prBody, 'utf-8');
  return tempFile;
}

function createOrUpdatePr(releaseTag, releaseBranch, changes) {
  const existingPrNumber = getExistingPrNumber(releaseBranch);
  const title = `Release ${releaseTag}`;
  const prBody = buildPrBody(releaseTag, releaseBranch, changes);
  const bodyFile = writeTempPrBody(prBody);

  try {
    if (existingPrNumber) {
      console.log(`Updating existing PR #${existingPrNumber}`);
      runGh([
        'pr',
        'edit',
        existingPrNumber,
        '--title', title,
        '--body-file', bodyFile,
      ]);
      return existingPrNumber;
    }

    console.log('Creating a new PR to master');
    runGh([
      'pr',
      'create',
      '--base', 'master',
      '--head', releaseBranch,
      '--title', title,
      '--body-file', bodyFile,
    ]);

    return getExistingPrNumber(releaseBranch);
  } finally {
    if (fs.existsSync(bodyFile)) {
      fs.unlinkSync(bodyFile);
    }
  }
}

function enableAutoMerge(prNumber) {
  if (!prNumber) {
    console.log('No PR number available. Skipping auto-merge enablement.');
    return;
  }

  console.log(`Enabling auto-merge for PR #${prNumber}`);

  const result = tryGh([
    'pr',
    'merge',
    String(prNumber),
    '--auto',
    '--merge',
    '--delete-branch',
  ]);

  if (!result.ok) {
    console.warn(`Unable to enable auto-merge for PR #${prNumber}.`);
    if (result.stdout) console.warn(`\nSTDOUT:\n${result.stdout}`);
    if (result.stderr) console.warn(`\nSTDERR:\n${result.stderr}`);
    return;
  }

  console.log(`Auto-merge enabled for PR #${prNumber}`);
}

function main() {
  validateEnv();
  ensureGitHubCli();

  run('git config user.name "github-actions[bot]"');
  run('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');

  run('git fetch origin --prune --tags');
  run('git checkout develop');
  run('git pull origin develop');
  run('git checkout master');
  run('git pull origin master');

  const changes = getMergedChanges();

  if (changes.length === 0) {
    console.log('No new user PR changes detected between develop and master. Skipping release PR.');
    process.exit(0);
  }

  const releaseBranch = createReleaseBranchFromMaster();
  mergeDevelopIntoReleaseBranch();

  const releaseTag = getTagFromReleaseBranch(releaseBranch);

  updateChangelog(changes);
  updateReadme(changes, releaseTag, releaseBranch);
  commitAndPush(releaseTag, releaseBranch);

  const prNumber = createOrUpdatePr(releaseTag, releaseBranch, changes);

  if (prNumber) {
    enableAutoMerge(prNumber);
    console.log(`Release PR is ready: #${prNumber}`);
  } else {
    console.log('Release PR creation/update completed.');
  }
}

main();
