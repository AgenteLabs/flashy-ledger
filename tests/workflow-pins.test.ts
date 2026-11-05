import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every third-party action this repository's workflows call is pinned to a
 * full commit SHA, never a floating tag or branch — a tag can be retargeted
 * upstream (by the action's own maintainer, or by an attacker who
 * compromises their account) and CI would silently start running whatever
 * that tag now points to. A commit SHA can't move.
 *
 * `AgenteLabs/flashy-infra/.github/workflows/secret-scan-reusable.yml@main`
 * is exempt: it is an internal, org-owned reusable workflow, not a
 * third-party action, so it does not carry the same retargeting risk this
 * test exists to catch.
 *
 * Line-based, not a real YAML parser, matching this repository's existing
 * convention: a `uses:` line is simple enough not to need one, and it would
 * only miss a `uses:` hidden inside a multi-line YAML string, which none of
 * these workflows have.
 */
const root = join(__dirname, '..');
const workflowsDir = join(root, '.github', 'workflows');
const SHA_PIN = /^[0-9a-f]{40}$/;
const INTERNAL_REUSABLE = /^AgenteLabs\//;

function findUsesLines(text: string) {
  return text
    .split('\n')
    .map((line, i) => ({ line: line.trim(), number: i + 1 }))
    .filter(({ line }) => line.startsWith('- uses:') || line.startsWith('uses:'));
}

describe('GitHub Actions are pinned by commit SHA', () => {
  const files = readdirSync(workflowsDir).filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  it('found at least one workflow file to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    it(`${file}: every third-party "uses:" is pinned to a 40-character commit SHA with a version comment`, () => {
      const text = readFileSync(join(workflowsDir, file), 'utf8');
      const usesLines = findUsesLines(text);
      expect(usesLines.length, `${file}: expected at least one "uses:" line`).toBeGreaterThan(0);

      for (const { line, number } of usesLines) {
        const match = line.match(/uses:\s*([^\s#]+)/);
        expect(match, `${file}:${number}: couldn't parse a "uses:" reference from "${line}"`).toBeTruthy();
        const ref = match?.[1] ?? '';
        if (INTERNAL_REUSABLE.test(ref)) continue;

        const at = ref.lastIndexOf('@');
        expect(at, `${file}:${number}: "${ref}" has no @<ref> at all`).not.toBe(-1);
        const pin = ref.slice(at + 1);
        expect(pin, `${file}:${number}: "${ref}" is pinned to "${pin}", not a 40-character commit SHA`).toMatch(SHA_PIN);
        expect(line, `${file}:${number}: "${line}" has no version comment after the SHA`).toMatch(/#\s*v?\d/);
      }
    });
  }
});
