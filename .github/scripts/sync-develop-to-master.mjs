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

    if (stderr.includes('GitHub Actions is not permitted to create or approve pull requests')) {
      console.error(
        '\nRepository setting required: Settings > Actions > General > Workflow permissions > ' +
        '"Read and write permissions" and enable "Allow GitHub Actions to create and approve pull requests".'
      );
    }

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

function getNextReleaseBranch() {
  const date = getFormattedDate();
  const base = sanitizeBranchName(`release/deploy_${date}`);

  const branchesRaw = run('git ls-remote --heads origin');
  const branches = branchesRaw
    .split('\n')
    .map((line) => line.split('\t')[1])
    .filter(Boolean)
    .map((ref) => ref.replace('refs/heads/', ''));

  const regex = new RegExp(`^${escapeRegExp(base)}_(\\d+)$`);
  let max = 0;

  for (const branch of branches) {
    const match = branch.match(regex);
    if (match) {
      const num = parseInt(match[1], 10);
      if (!Number.isNaN(num) && num > max) {
        max = num;
      }
    }
  }

  return `${base}_${max + 1}`;
}

function createReleaseBranchFromDevelop() {
  const candidate = getNextReleaseBranch();
  console.log(`Using release branch: ${candidate}`);

  const first = tryRun(`git checkout -b ${candidate} origin/develop`);
  if (first.ok) return candidate;

  console.warn(`Branch creation failed for ${candidate}. Retrying once...`);

  const retryCandidate = getNextReleaseBranch();
  const retry = tryRun(`git checkout -b ${retryCandidate} origin/develop`);

  if (!retry.ok) {
    console.error('Unable to create release branch after retry.');
    if (retry.stdout) console.error(`\nSTDOUT:\n${retry.stdout}`);
    if (retry.stderr) console.error(`\nSTDERR:\n${retry.stderr}`);
    process.exit(1);
  }

  console.log(`Using release branch after retry: ${retryCandidate}`);
  return retryCandidate;
}

function getReleaseNumber(releaseBranch) {
  const match = releaseBranch.match(/_(\d+)$/);
  return match ? match[1] : '1';
}

function getVersion(releaseBranch) {
  const date = getFormattedDate();
  const releaseNumber = getReleaseNumber(releaseBranch);
  return `v${date}_${releaseNumber}`;
}

function getDevelopOnlyCommits() {
  const raw = tryRun('git log origin/master..origin/develop --pretty=format:"%H"');
  if (!raw.ok || !raw.output) return [];
  return raw.output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

function getMergedChanges() {
  const repo = process.env.GITHUB_REPOSITORY;
  const developOnlyCommits = getDevelopOnlyCommits();

  if (developOnlyCommits.length === 0) {
    return [];
  }

  const developOnlySet = new Set(developOnlyCommits);

  const result = tryGh([
    'pr',
    'list',
    '--repo', repo,
    '--base', 'develop',
    '--state', 'closed',
    '--limit', '100',
    '--json', 'number,title,url,mergedAt',
  ]);

  if (!result.ok) {
    console.warn('Unable to fetch merged PRs from GitHub. Falling back to git log subjects.');
    const raw = run('git log origin/master..origin/develop --pretty=format:"%s"');
    if (!raw) return [];
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((title) => ({
        title,
        number: null,
        url: null,
      }));
  }

  let prs = [];
  try {
    prs = JSON.parse(result.output || '[]');
  } catch {
    console.warn('Failed to parse PR list. Falling back to git log subjects.');
    const raw = run('git log origin/master..origin/develop --pretty=format:"%s"');
    if (!raw) return [];
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((title) => ({
        title,
        number: null,
        url: null,
      }));
  }

  const mergedChanges = [];

  for (const pr of prs) {
    if (!pr.mergedAt || !pr.number) continue;

    const view = tryGh([
      'pr',
      'view',
      String(pr.number),
      '--repo', repo,
      '--json', 'commits',
    ]);

    if (!view.ok) {
      continue;
    }

    let details;
    try {
      details = JSON.parse(view.output || '{}');
    } catch {
      continue;
    }

    const prCommitShas = (details.commits || [])
      .map((commit) => commit.oid)
      .filter(Boolean);

    const included = prCommitShas.some((sha) => developOnlySet.has(sha));
    if (!included) continue;

    mergedChanges.push({
      title: pr.title,
      number: pr.number,
      url: pr.url,
    });
  }

  const seen = new Set();
  return mergedChanges.filter((item) => {
    const key = `${item.number}-${item.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatChangeForMarkdown(change) {
  if (change.number && change.url) {
    return `- ${change.title} ([#${change.number}](${change.url}))`;
  }
  return `- ${change.title}`;
}

function updateChangelog(changes, version) {
  const filePath = 'CHANGELOG.md';
  ensureFileExists(filePath, '# Changelog\n\n');

  let existing = fs.readFileSync(filePath, 'utf-8');
  if (!existing.trim()) {
    existing = '# Changelog\n\n';
  }

  const displayDate = getDisplayDate();
  const lines = [
    `## ${displayDate}`,
    '',
    `### Release ${version}`,
    '',
  ];

  if (changes.length === 0) {
    lines.push('- No application changes detected between develop and master.');
  } else {
    for (const change of changes) {
      lines.push(formatChangeForMarkdown(change));
    }
  }

  lines.push('');
  const entry = `${lines.join('\n')}\n`;

  const headerMatch = existing.match(/^# .*\n+/);
  if (headerMatch) {
    const header = headerMatch[0];
    const rest = existing.slice(header.length).trimStart();
    fs.writeFileSync(filePath, `${header}${entry}${rest ? `${rest}\n` : ''}`, 'utf-8');
  } else {
    fs.writeFileSync(filePath, `# Changelog\n\n${entry}${existing}`, 'utf-8');
  }
}

function updateReadme(changes, version, releaseBranch) {
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
  const prStatusBadge = '![PR Status](https://img.shields.io/badge/release_pr-open-blue)';
  const releaseBadge = `![Release](https://img.shields.io/badge/release-${version}-green)`;
  const branchBadge = `![Branch](https://img.shields.io/badge/branch-${releaseBranch.replace(/\//g, '%2F')}-orange)`;

  const changesBlock = changes.length === 0
    ? '- No application changes detected between develop and master.'
    : changes.map((item) => formatChangeForMarkdown(item)).join('\n');

  const section = [
    '## Latest Automated Release',
    '',
    `${prStatusBadge} ${releaseBadge} ${branchBadge}`,
    '',
    `- Repository: \`${ownerRepo}\``,
    `- Release Version: \`${version}\``,
    `- Release Branch: \`${releaseBranch}\``,
    '- Source Branch: `develop`',
    '- Target Branch: `master`',
    `- Generated On: \`${new Date().toISOString()}\``,
    '',
    '<details>',
    '<summary>Included Changes</summary>',
    '',
    changesBlock,
    '',
    '</details>',
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

function commitAndPush(version, releaseBranch) {
  run('git add CHANGELOG.md README.md');

  if (!hasTrackedFileChanges()) {
    console.log('No documentation changes detected. Skipping commit.');
    return false;
  }

  run(`git commit -m "chore: release ${version}"`);
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

function buildPrBody(version, releaseBranch, changes) {
  const lines = [
    '## Automated Release PR',
    '',
    `- Release Version: \`${version}\``,
    `- Release Branch: \`${releaseBranch}\``,
    '- Source Branch: `develop`',
    '- Target Branch: `master`',
    '',
    '### Validation',
    '- Generated automatically after changes were merged into `develop`.',
    '- Includes updates to `CHANGELOG.md` and `README.md`.',
    '- Designed to respect protected `master` branch rules by opening a PR instead of pushing directly.',
    '',
    '### Changes Included',
  ];

  if (changes.length === 0) {
    lines.push('- No application changes detected between develop and master.');
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

function createOrUpdatePr(version, releaseBranch, changes) {
  const existingPrNumber = getExistingPrNumber(releaseBranch);
  const title = `Release ${version}`;
  const prBody = buildPrBody(version, releaseBranch, changes);
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

function main() {
  validateEnv();
  ensureGitHubCli();

  run('git config user.name "github-actions[bot]"');
  run('git config user.email "41898282+github-actions[bot]@users.noreply.github.com"');

  run('git fetch origin --prune');
  run('git checkout develop');
  run('git pull origin develop');
  run('git checkout master');
  run('git pull origin master');

  const releaseBranch = createReleaseBranchFromDevelop();
  const version = getVersion(releaseBranch);
  const changes = getMergedChanges();

  updateChangelog(changes, version);
  updateReadme(changes, version, releaseBranch);
  commitAndPush(version, releaseBranch);
  const prNumber = createOrUpdatePr(version, releaseBranch, changes);

  if (prNumber) {
    console.log(`Release PR is ready: #${prNumber}`);
  } else {
    console.log('Release PR creation/update completed.');
  }
}

main();
