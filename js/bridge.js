// bridge.js — connecting a Bitbucket repository to Jules.
//
// Jules only understands GitHub. Its own documentation is explicit that it
// "can only access repositories you explicitly allow through GitHub", and
// support for other version-control systems is future work. So a Bitbucket
// project reaches Jules one of two ways, and this module builds the material
// for both:
//
//   MIRROR (reliable)     Bitbucket stays the source of truth and pushes to a
//                         private GitHub repo that Jules is connected to.
//                         Every Jules feature keeps working natively. This
//                         module generates the two CI files that maintain it.
//
//   DIRECT (experimental) A "repoless" Jules session clones from Bitbucket
//                         inside its own VM using a token, works there, and
//                         pushes a branch back. No GitHub involved — but it
//                         depends on Jules' sandbox having outbound network
//                         access, which Google does not document. Rather than
//                         guess, this module can run a self-test that answers
//                         the question with the user's own account.
//
// Nothing here performs git operations in the browser: Bitbucket's git
// smart-HTTP endpoints send no CORS headers, so in-browser git is impossible.
// These are strings for Jules to run, or files for the user to paste.

import { cloneUrl } from './bitbucket.js';

/** Branch namespace Jules pushes into. Kept disjoint from the user's branches
 *  so the two mirror directions can never chase each other in a loop. */
export const JULES_BRANCH_PREFIX = 'jules/';

/**
 * Turn a task description into a short, git-legal branch suffix.
 * @param {string} task
 * @returns {string} e.g. "jules/add-dark-mode-toggle"
 */
export function julesBranchName(task) {
  const slug = String(task || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 6)
    .join('-');
  const stamp = new Date().toISOString().slice(5, 10).replace('-', '');
  return JULES_BRANCH_PREFIX + (slug || 'task') + '-' + stamp;
}

/**
 * The prompt for a direct (repoless) Bitbucket session.
 *
 * @param {{workspace:string, repo:string, branch?:string, task:string,
 *          token:string, mode?:string, branchName?:string, openPr?:boolean}} spec
 * @returns {string}
 */
export function bridgePrompt(spec = {}) {
  const url = cloneUrl({ workspace: spec.workspace, repo: spec.repo, token: spec.token, mode: spec.mode });
  const startBranch = spec.branch || 'main';
  const workBranch = spec.branchName || julesBranchName(spec.task);

  return [
    'This session has no repository attached. The code lives in Bitbucket, so start by cloning it.',
    '',
    'Setup — run these first:',
    '',
    '  git clone --branch ' + startBranch + ' "' + url + '" work',
    '  cd work',
    '  git config user.name "Jules"',
    '  git config user.email "jules@users.noreply.bitbucket.org"',
    '  git checkout -b ' + workBranch,
    '',
    'If the clone fails, stop and report the exact error instead of trying to',
    'work around it — it most likely means this sandbox cannot reach the',
    'internet, which is something the user needs to know.',
    '',
    'The task:',
    '',
    spec.task || '',
    '',
    'When the work is done and you are happy with it:',
    '',
    '  git add -A',
    '  git commit -m "<a clear summary of what you changed>"',
    '  git push origin ' + workBranch,
    '',
    'Then report the branch name (' + workBranch + ') and what you changed.',
    '',
    'Important: the clone URL above contains an access token. Never echo it,',
    'never write it into a file, and never include it in your summary. Refer to',
    'the remote as "origin".',
  ].join('\n');
}

/**
 * A tiny session whose only job is to answer "can Jules' VM reach Bitbucket?".
 *
 * This is the honest way to resolve the one thing about the direct path that
 * cannot be looked up: Google does not document whether the sandbox has
 * outbound network access. One run settles it for this account.
 *
 * @param {{workspace:string, repo:string, token:string, mode?:string}} spec
 * @returns {string}
 */
export function selfTestPrompt(spec = {}) {
  const url = cloneUrl({ workspace: spec.workspace, repo: spec.repo, token: spec.token, mode: spec.mode });
  return [
    'Connectivity check only. Do not create, modify or delete any file, and do',
    'not attempt the rest of any task.',
    '',
    'Run exactly this one command:',
    '',
    '  git ls-remote --heads "' + url + '"',
    '',
    'Then report, in this order:',
    '  1. Did the command succeed? (yes/no)',
    '  2. Its exit code.',
    '  3. If it succeeded: how many branches it listed, and their names.',
    '  4. If it failed: the complete error message, verbatim.',
    '',
    'Do not print the URL itself — it contains an access token.',
    'Finish as soon as you have reported this. Nothing else is needed.',
  ].join('\n');
}

/** Title used for self-test sessions, so they are recognisable in the list. */
export const SELF_TEST_TITLE = 'Bitbucket connectivity check';

/**
 * `bitbucket-pipelines.yml` — mirrors Bitbucket to the GitHub repo Jules sees.
 *
 * The `--force --all` here is load-bearing. Nearly every tutorial online says
 * `git push --mirror`, but --mirror prunes: it deletes refs on the remote that
 * don't exist locally. With Jules pushing its work branches to GitHub only,
 * a --mirror sync would delete Jules' branches on the next push from Bitbucket.
 *
 * @param {{owner:string, repo:string}} github
 * @returns {string}
 */
export function pipelinesYaml(github = {}) {
  const target = 'git@github.com:' + (github.owner || 'YOUR-GITHUB-USER') + '/' + (github.repo || 'YOUR-MIRROR-REPO') + '.git';
  return [
    '# Mirrors this repository to a private GitHub repo so Google Jules can work on it.',
    '#',
    '# One-time setup:',
    '#   1. Repository settings > Pipelines > Settings > Enable Pipelines',
    '#   2. Repository settings > Pipelines > SSH keys > Generate keys,',
    '#      then under "Known hosts" add  github.com  and press Fetch.',
    '#   3. Copy the public key shown there into GitHub:',
    '#      your mirror repo > Settings > Deploy keys > Add deploy key,',
    '#      and tick "Allow write access".',
    '#',
    '# Note: this uses `git push --force --all`, NOT `git push --mirror`.',
    '# --mirror deletes remote branches that do not exist here, which would wipe',
    '# out every branch Jules creates on GitHub on the very next sync.',
    '',
    'image: atlassian/default-image:4',
    '',
    'clone:',
    '  depth: full',
    '',
    'pipelines:',
    '  branches:',
    "    # Only your own branches are mirrored. Branches Jules pushes back",
    "    # (jules/**) are deliberately excluded so the two directions never",
    '    # touch the same refs and no sync loop can form.',
    "    '{main,master,develop,feature/**,release/**}':",
    '      - step:',
    '          name: Mirror to GitHub',
    '          script:',
    '            - git push --force --all ' + target,
    '            - git push --force --tags ' + target,
    '',
  ].join('\n');
}

/**
 * `.github/workflows/sync-jules-to-bitbucket.yml` — brings Jules' branches home.
 *
 * Scoped to the jules/** namespace on purpose. A push made with a deploy key
 * (which is how the forward mirror arrives) *does* trigger workflows, so
 * without this branch filter the two mirrors would trigger each other.
 *
 * @param {{workspace:string, repo:string}} bitbucketRepo
 * @returns {string}
 */
export function backSyncYaml(bitbucketRepo = {}) {
  const ws = bitbucketRepo.workspace || 'YOUR-WORKSPACE';
  const slug = bitbucketRepo.repo || 'YOUR-REPO';
  // Assembled without template literals so GitHub's ${{ ... }} syntax survives.
  return [
    'name: Push Jules branches back to Bitbucket',
    '',
    '# Only branches Jules created travel back to Bitbucket. Your own branches',
    '# flow the other way (Bitbucket -> GitHub), so the two directions never',
    '# write the same refs and a loop cannot form.',
    '#',
    '# Setup: add a repository secret named BITBUCKET_TOKEN containing an',
    '# Atlassian API token that has write:repository:bitbucket scope',
    '# (Settings > Secrets and variables > Actions > New repository secret).',
    '',
    'on:',
    '  push:',
    '    branches:',
    "      - 'jules/**'",
    '  workflow_dispatch:',
    '',
    'jobs:',
    '  push-to-bitbucket:',
    '    runs-on: ubuntu-latest',
    '    steps:',
    '      - uses: actions/checkout@v4',
    '        with:',
    '          fetch-depth: 0',
    '',
    '      - name: Push this branch to Bitbucket',
    '        env:',
    '          BITBUCKET_TOKEN: ' + '${{ secrets.BITBUCKET_TOKEN }}',
    '        run: |',
    '          branch="${GITHUB_REF#refs/heads/}"',
    '          remote="https://x-bitbucket-api-token-auth:${BITBUCKET_TOKEN}@bitbucket.org/' + ws + '/' + slug + '.git"',
    '          git push "$remote" "HEAD:refs/heads/${branch}"',
    '',
  ].join('\n');
}

export default {
  julesBranchName,
  bridgePrompt,
  selfTestPrompt,
  pipelinesYaml,
  backSyncYaml,
};
