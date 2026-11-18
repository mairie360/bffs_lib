import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The release secrets live in the Prod environment (main only) and reach the prod promotion
// alone; pull request runs only get the low-quota key of the AI reviews. The workflows are read
// job by job, so a quoted `inherit`, a key mapped from another secret or a release secret read by
// another job of the same file are caught too.
const root = join(__dirname, '..');
const dir = join(root, '.github/workflows');
const RELEASE_JOBS = ['promote-prod.yml:promote'];
const RELEASE = /secrets\.(RELEASE_APP_ID|RELEASE_APP_PK|ANTHROPIC_API_KEY)\b/g;
const REVIEW_CALLERS =
  /mairie360\/CICD\/\.github\/workflows\/(APIs_cicd|BFFs-cicd|front-libs-cicd|gdpr-pr-cicd|promote-prod)\.yml@/;

interface Job {
  where: string;
  uses: string;
  secrets: string | Record<string, string> | null;
  lines: string[];
}

const stripComment = (line: string): string => line.replace(/(^|\s)#.*$/, '').trimEnd();

function parseJobs(file: string, text: string): Job[] {
  const jobs: Job[] = [];
  let inJobs = false;
  let inSecrets = false;
  let job: Job | null = null;
  for (const raw of text.split('\n')) {
    const line = stripComment(raw);
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs || !line.trim()) continue;
    if (/^\S/.test(line)) {
      inJobs = false;
      job = null;
      continue;
    }
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (header) {
      job = { where: `${file}:${header[1]}`, uses: '', secrets: null, lines: [] };
      jobs.push(job);
      inSecrets = false;
      continue;
    }
    if (!job) continue;
    job.lines.push(line);
    const indent = line.length - line.trimStart().length;
    if (inSecrets && indent <= 4) inSecrets = false;
    if (inSecrets) {
      const entry = /^\s+([A-Za-z0-9_]+):\s*(.+)$/.exec(line);
      if (entry && typeof job.secrets === 'object' && job.secrets) job.secrets[entry[1]] = entry[2].trim();
      continue;
    }
    const uses = /^ {4}uses:\s*(\S+)/.exec(line);
    if (uses) job.uses = uses[1].replace(/^['"]|['"]$/g, '');
    const secrets = /^ {4}secrets:\s*(.*)$/.exec(line);
    if (secrets) {
      const value = secrets[1].trim().replace(/^['"]|['"]$/g, '');
      job.secrets = value || {};
      inSecrets = !value;
    }
  }
  return jobs;
}

const workflows = readdirSync(dir)
  .filter((file) => /\.ya?ml$/.test(file))
  .map((file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    const live = text.split('\n').map(stripComment).join('\n');
    return { file, live, jobs: parseJobs(file, text) };
  });
const jobs = workflows.flatMap((workflow) => workflow.jobs);
const mapping = (job: Job): Record<string, string> =>
  typeof job.secrets === 'object' && job.secrets ? job.secrets : {};
const releaseReads = (text: string): number => text.match(RELEASE)?.length ?? 0;

const readsOnly = (expression: string, key: string): boolean =>
  (expression.match(/secrets\.[A-Za-z0-9_]+/g) ?? []).join(',') === `secrets.${key}`;

describe('MAIR-681 CI secrets', () => {
  it('no reusable workflow call inherits every secret', () => {
    const inheriting = jobs.filter((job) => typeof job.secrets === 'string');
    expect(inheriting.map((job) => `${job.where}: ${String(job.secrets)}`)).toEqual([]);
  });

  it('each secret handed to a reusable workflow is read from the secret of the same name', () => {
    const remapped = jobs.flatMap((job) =>
      Object.entries(mapping(job))
        .filter(([key, expression]) => !readsOnly(expression, key))
        .map(([key, expression]) => `${job.where}: ${key} reads ${expression}`),
    );
    expect(remapped).toEqual([]);
  });

  it('the release secrets are only read by the prod promotion job', () => {
    for (const workflow of workflows) {
      const inReleaseJobs = workflow.jobs
        .filter((job) => RELEASE_JOBS.includes(job.where))
        .reduce((count, job) => count + releaseReads(job.lines.join('\n')), 0);
      expect([workflow.file, releaseReads(workflow.live)]).toEqual([workflow.file, inReleaseJobs]);
    }
  });

  it('every AI review gets its dedicated key', () => {
    const missing = jobs.filter(
      (job) => REVIEW_CALLERS.test(job.uses) && !('ANTHROPIC_REVIEW_API_KEY' in mapping(job)),
    );
    expect(missing.map((job) => job.where)).toEqual([]);
    expect(jobs.some((job) => job.uses.includes('gdpr-pr-cicd.yml@'))).toBe(true);
  });

  it('the release journal is no longer tracked', () => {
    const tracked = execFileSync('git', ['ls-files', '--', 'RELEASE_JOURNAL.md'], { cwd: root, encoding: 'utf8' });
    expect(tracked.trim()).toBe('');
  });
});
