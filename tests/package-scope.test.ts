// This package moved from the @flashyos npm scope to @flashynetwork (part of
// an estate-wide npm scope reorganisation; see README.md "Publishing" and
// RELEASES.md). A rename like this has no code path that fails loudly if a
// reference is missed — an old import still resolves locally through a
// symlinked node_modules, and a stale scope in a workflow only shows up the
// next time that workflow actually runs against the registry. So this is a
// text sweep over every place the old scope could have been left behind,
// plus a check that the one workflow allowed to touch the old scope on the
// registry (deprecating it) can never fire on its own.
//
// Style note: this repository's other tests/*.test.ts files are vitest
// (import { describe, expect, it } from 'vitest', node:fs / node:path,
// __dirname — see tests/releases.test.ts). This file follows that
// convention rather than wdk-capability-audit's node:test style, which it
// was adapted from.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

const OLD_SCOPE = '@flashyos/ledger';
const NEW_SCOPE = '@flashynetwork/ledger';

// Files whose old-scope text is legitimate and must stay exactly as it is:
// the deprecate workflow has to name the scope it deprecates, RELEASES.md is
// a historical ledger that must keep every prior scope's rows intact, and
// README.md carries its own "renamed from" prose about the @flashylabs and
// @flashyos history on purpose.
const ALLOWED_OLD_SCOPE_FILES = new Set([
  join(ROOT, '.github', 'workflows', 'deprecate-old-scope.yml'),
  join(ROOT, 'RELEASES.md'),
  join(ROOT, 'README.md'),
]);

// CHANGELOG.md does not exist in this repository today (DEVLOG.md is
// generated and is not where a rename note belongs); if one is added later
// and legitimately needs to name the old scope, add it to the allowlist
// above rather than here.

function sweepFiles(): string[] {
  const files = [
    join(ROOT, 'package.json'),
    join(ROOT, 'README.md'),
  ];
  const lockfile = join(ROOT, 'package-lock.json');
  if (existsSync(lockfile)) files.push(lockfile);
  const workflowsDir = join(ROOT, '.github', 'workflows');
  for (const f of readdirSync(workflowsDir)) {
    files.push(join(workflowsDir, f));
  }
  return files;
}

describe('npm scope rename: @flashyos/ledger -> @flashynetwork/ledger', () => {
  it('package.json publishes under the new scope', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      name: string;
      publishConfig?: { access?: string };
    };
    expect(pkg.name).toBe(NEW_SCOPE);
    expect(
      pkg.publishConfig?.access,
      'publishConfig.access must be "public" for a scoped package meant to be installable by anyone',
    ).toBe('public');
  });

  it('no file this rename touches still names the old scope, except where it is naming it on purpose', () => {
    const files = sweepFiles();
    expect(files.length).toBeGreaterThan(2);
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWED_OLD_SCOPE_FILES.has(f)) continue;
      const text = readFileSync(f, 'utf8');
      if (text.includes(OLD_SCOPE)) offenders.push(f);
    }
    expect(offenders, `these files still reference ${OLD_SCOPE}: ${offenders.join(', ')}`).toEqual([]);
  });

  it('publish.yml names the new scope and not the old one', () => {
    const text = readFileSync(join(ROOT, '.github', 'workflows', 'publish.yml'), 'utf8');
    expect(text.includes(NEW_SCOPE)).toBe(true);
    expect(text.includes(OLD_SCOPE)).toBe(false);
  });

  it('the old-scope deprecation workflow exists, names the old scope, and calls npm deprecate', () => {
    const path = join(ROOT, '.github', 'workflows', 'deprecate-old-scope.yml');
    const text = readFileSync(path, 'utf8');
    expect(text.includes(OLD_SCOPE)).toBe(true);
    expect(text.includes('npm deprecate')).toBe(true);
  });

  it('the deprecation workflow triggers on workflow_dispatch only — never push, pull_request or schedule', () => {
    const path = join(ROOT, '.github', 'workflows', 'deprecate-old-scope.yml');
    const text = readFileSync(path, 'utf8');

    const onMatch = /^on:\n((?:[ \t].*\n?)*)/m.exec(text);
    expect(onMatch, 'could not find an "on:" trigger block').toBeTruthy();
    const triggerBlock = onMatch![1]!;

    expect(/workflow_dispatch:/.test(triggerBlock)).toBe(true);
    for (const forbidden of ['push:', 'pull_request:', 'schedule:', 'branch_protection_rule:']) {
      expect(
        triggerBlock.includes(forbidden),
        `the deprecation workflow must never trigger on "${forbidden}"`,
      ).toBe(false);
    }
  });

  it('the deprecation workflow reuses the existing npm credential, not a secret invented for it alone', () => {
    const path = join(ROOT, '.github', 'workflows', 'deprecate-old-scope.yml');
    const text = readFileSync(path, 'utf8');
    expect(
      text.includes('secrets.NPM_TOKEN_FLASHYNETWORK_CI') || text.includes('secrets.NPM_TOKEN'),
    ).toBe(true);
  });
});
