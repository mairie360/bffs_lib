// MAIR-771: every workflow of this repo calls the same mairie360/CICD release, v4.12.0 or later (the
// first one with the GDPR controls). This guard fails when a workflow falls behind that release, or
// when the workflows disagree on the version they call (the `uses:` ref and `cicd_version` must stay
// equal, since the actions are checked out at `cicd_version`).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIN_CICD = [4, 12, 0];
const WORKFLOW_DIR = join(__dirname, '..', '.github', 'workflows');
const WORKFLOWS = readdirSync(WORKFLOW_DIR).filter((name) => /\.ya?ml$/.test(name)).sort();

const readWorkflow = (name: string): string =>
  readFileSync(join(WORKFLOW_DIR, name), 'utf8');

const parseVersion = (raw: string): number[] | null => {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  return match ? match.slice(1).map(Number) : null;
};

const atLeast = (version: number[], min: number[]): boolean => {
  for (let i = 0; i < min.length; i += 1) {
    if (version[i] !== min[i]) return version[i] > min[i];
  }
  return true;
};

// Every CICD version a workflow names: the `uses:` refs (the `# vX.Y.Z` comment of a SHA pin)
// and the `cicd_version:` inputs.
const cicdVersions = (workflow: string): string[] =>
  workflow.split('\n').flatMap((raw) => {
    const line = raw.trim();
    const uses = /^uses: mairie360\/CICD\/[^@]*@([^\s#]+)\s*(?:#\s*(\S+))?/.exec(line);
    if (uses) return [uses[2] ?? uses[1]];
    const input = /^cicd_version:\s*([^\s#]+)/.exec(line);
    return input ? [input[1]] : [];
  });

describe('MAIR-771 CICD release carrying the GDPR controls', () => {
  it('every workflow calls the same CICD release, v4.12.0 or later', () => {
    const seen = WORKFLOWS.flatMap((name) =>
      cicdVersions(readWorkflow(name)).map((version) => ({ name, version })),
    );
    expect(seen.length).toBeGreaterThan(0);
    const expected = seen[0].version;
    expect(seen.filter(({ version }) => version !== expected)).toEqual([]);
    const parsed = parseVersion(expected);
    expect(parsed).not.toBeNull();
    expect(atLeast(parsed as number[], MIN_CICD)).toBe(true);
  });

  it('the parser rejects what is not a release and reads SHA pins from their comment', () => {
    expect(parseVersion('v5.2.2')).toEqual([5, 2, 2]);
    expect(atLeast(parseVersion('v4.4.3') as number[], MIN_CICD)).toBe(false);
    expect(atLeast(parseVersion('v4.12.0') as number[], MIN_CICD)).toBe(true);
    expect(parseVersion('main')).toBeNull();
    expect(
      cicdVersions(
        '    uses: mairie360/CICD/.github/workflows/x.yml@0123abc # v5.2.2\n      cicd_version: v5.2.2  # note',
      ),
    ).toEqual(['v5.2.2', 'v5.2.2']);
  });
});
