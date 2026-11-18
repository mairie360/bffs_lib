import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The release secrets live in the Prod environment (main only) and reach the prod promotion
// alone; pull request runs only get the low-quota key of the AI reviews.
const root = join(__dirname, '..');
const dir = join(root, '.github/workflows');
const workflows = readdirSync(dir)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));
const RELEASE_ONLY = ['promote-prod.yml'];

describe('MAIR-681 CI secrets', () => {
  it('no workflow hands every secret to a reusable workflow', () => {
    expect(workflows.filter(({ text }) => /secrets:\s*inherit/.test(text)).map(({ file }) => file)).toEqual([]);
  });

  it('the release secrets only reach the prod promotion', () => {
    const leaks = workflows
      .filter(({ file }) => !RELEASE_ONLY.includes(file))
      .filter(({ text }) => /^\s+(RELEASE_APP_ID|RELEASE_APP_PK|ANTHROPIC_API_KEY):/m.test(text))
      .map(({ file }) => file);
    expect(leaks).toEqual([]);
  });

  it('the AI review of the pull requests gets its dedicated key', () => {
    const gdpr = workflows.find(({ file }) => file === 'gdpr-pr.yml');
    expect(gdpr?.text).toMatch(/^ {6}ANTHROPIC_REVIEW_API_KEY: \$\{\{ secrets\.ANTHROPIC_REVIEW_API_KEY \}\}$/m);
  });

  it('the release journal is no longer committed', () => {
    expect(existsSync(join(root, 'RELEASE_JOURNAL.md'))).toBe(false);
  });
});
