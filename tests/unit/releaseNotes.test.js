import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// scripts/release-notes.sh gives the image workflow the text of a release page
// (and stops a release without one before anything is built).

const script = path.resolve('scripts/release-notes.sh');
const notesFor = (version, changelog) => spawnSync('bash', [script, version, changelog], { encoding: 'utf8' });

describe('release notes from the changelog', () => {
  let dir;
  let changelog;
  const write = (text) => fs.writeFileSync(changelog, text);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-notes-'));
    changelog = path.join(dir, 'CHANGELOG.md');
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('gives the summary of a version: up to the first ### heading, nothing of the others', () => {
    write([
      '# Changelog',
      '',
      '## [Unreleased]',
      '',
      '## [0.3.0] - 2026-10-20',
      '',
      'Third summary.',
      '',
      '### Added',
      '- third detail',
      '',
      '## [0.2.0] - 2026-09-29',
      '',
      '**Главное**',
      '',
      '- one',
      '- two',
      '',
      '### Added',
      '- a detail that stays in the changelog',
      '',
      '## [0.1.0] - 2026-01-01',
      'First.',
      ''
    ].join('\n'));

    const result = notesFor('0.2.0', changelog);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('**Главное**');
    expect(result.stdout).toContain('- two');
    expect(result.stdout).not.toContain('a detail that stays');
    expect(result.stdout).not.toContain('Third summary');
    expect(result.stdout).not.toContain('First.');
    expect(notesFor('0.1.0', changelog).stdout.trim()).toBe('First.');
  });

  it('fails, and says so, when the version has no section', () => {
    write('# Changelog\n\n## [0.2.0] - 2026-09-29\n\nText.\n');
    const result = notesFor('0.3.0', changelog);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("no section '## [0.3.0]'");
  });

  it('fails when the section has no summary, only detail lists', () => {
    write('# Changelog\n\n## [0.2.0] - 2026-09-29\n\n### Added\n- something\n');
    const result = notesFor('0.2.0', changelog);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('no summary for 0.2.0');
  });

  it('does not take a pre-release, or a longer version, for the release', () => {
    write('# Changelog\n\n## [0.2.0-rc.1] - 2026-09-20\n\nOnly the candidate.\n\n## [0.2.10] - 2026-09-25\n\nOnly ten.\n');
    expect(notesFor('0.2.0', changelog).status).not.toBe(0);
    expect(notesFor('0.2.0-rc.1', changelog).stdout.trim()).toBe('Only the candidate.');
    expect(notesFor('0.2.1', changelog).status).not.toBe(0);
  });

  it('finds 0.2.1 among 0.2.10 and 0.2.1, not the first that starts alike', () => {
    write('# Changelog\n\n## [0.2.10] - 2026-10-01\n\nOnly ten.\n\n## [0.2.1] - 2026-09-25\n\nOnly one.\n');
    expect(notesFor('0.2.1', changelog).stdout.trim()).toBe('Only one.');
    expect(notesFor('0.2.10', changelog).stdout.trim()).toBe('Only ten.');
  });

  it('holds for the version in package.json (a release cannot be tagged without its text)', () => {
    const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    const result = notesFor(version, path.resolve('CHANGELOG.md'));
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(40);
  });
});
