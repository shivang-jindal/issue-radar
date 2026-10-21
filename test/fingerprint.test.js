import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FOOTPRINT_RATIO,
  buildFingerprint,
  gitignoreMatches,
  languageShare,
  labelAffinity,
  languageMatches,
  matchScore,
  normalizeLanguageName,
  parseGitignore,
  sizeComfort,
  subsystemAffinity,
} from '../src/fingerprint.js';

const NOW = () => new Date('2026-10-20T12:00:00.000Z');

function makeTree(t, files) {
  const root = mkdtempSync(join(tmpdir(), 'radar-fp-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

test('buildFingerprint: languages by bytes, top-dir clusters, typical size', (t) => {
  const root = makeTree(t, {
    'src/app.ts': 'x'.repeat(400),
    'src/util.ts': 'y'.repeat(200),
    'test/app.test.ts': 'z'.repeat(100),
    'README.md': 'm'.repeat(100),
    'src/skip.me': 'ignored by gitignore',
  });
  writeFileSync(join(root, '.gitignore'), 'src/skip.me\n', 'utf8');

  const fp = buildFingerprint({ root, now: NOW });
  assert.equal(fp.version, 1);
  assert.equal(fp.generatedAt, '2026-10-20T12:00:00.000Z');
  assert.deepEqual(Object.keys(fp.languages).sort(), ['md', 'ts']);
  // .gitignore (12 bytes) stays in the tree but has no extension
  const gitignoreBytes = Buffer.byteLength('src/skip.me\n');
  const total = 400 + 200 + 100 + 100 + gitignoreBytes;
  assert.equal(total, 812);
  assert.ok(
    Math.abs(fp.languages.ts - (400 + 200 + 100) / total) < 1e-4,
    '700 of 812 bytes are ts (app + util + test file)',
  );
  assert.ok(Math.abs(fp.languages.md - 100 / total) < 1e-4, 'shares are round4');
  assert.ok(fp.languages.ts + fp.languages.md < 1, 'extensionless files dilute the shares');
  // clusters: src 600B, test 100B (root files are not a cluster)
  assert.deepEqual(Object.keys(fp.clusters), ['src', 'test']);
  assert.ok(fp.clusters.src > fp.clusters.test);
  assert.equal(fp.clusters['.'], undefined);
  assert.equal(fp.typical.fileCount, 5, 'gitignored file excluded, .gitignore counted');
  assert.equal(fp.typical.medianFileBytes, 100, 'sizes 12,100,100,200,400 → median 100');
  assert.equal(fp.typical.footprintFiles, 1, 'max(1, round(5 · 0.02))');
});

test('buildFingerprint respects .gitignore dirs/patterns and always skips .git/node_modules', (t) => {
  const root = makeTree(t, {
    'src/main.ts': 'a'.repeat(300),
    'node_modules/pkg/index.js': 'b'.repeat(9999),
    '.git/objects/aa': 'c'.repeat(9999),
    'dist/bundle.js': 'd'.repeat(9999),
    'logs/debug.log': 'e'.repeat(9999),
    'keep/keep.log': 'kept',
  });
  writeFileSync(join(root, '.gitignore'), 'dist/\n*.log\n!keep/keep.log\n', 'utf8');

  const fp = buildFingerprint({ root, now: NOW });
  assert.deepEqual(Object.keys(fp.languages).sort(), ['log', 'ts'], 'negated .log survives');
  assert.ok(fp.languages.ts > 0.9, 'junk trees (node_modules/.git/dist) are excluded');
  assert.equal(fp.typical.fileCount, 3, 'main.ts + kept log + .gitignore');
  assert.equal(Object.keys(fp.clusters)[0], 'src');
  assert.ok(fp.clusters.src > 0.9);
});

test('parseGitignore/gitignoreMatches: minimal semantics', () => {
  const rules = parseGitignore('# comment\n\ndist/\n*.log\n/build\nsub/**/tmp\n!keep.log\n');
  assert.equal(gitignoreMatches('dist', true, rules), true);
  assert.equal(gitignoreMatches('dist', false, rules), false, 'dir-only rule ignores dirs only');
  assert.equal(gitignoreMatches('a/b.log', false, rules), true);
  assert.equal(gitignoreMatches('build', true, rules), true, 'anchored to root');
  assert.equal(gitignoreMatches('other/build', true, rules), false);
  assert.equal(gitignoreMatches('keep.log', false, rules), false, 'negation re-includes');
  assert.equal(gitignoreMatches('sub/deep/tmp', false, rules), true, '** glob');
  assert.equal(gitignoreMatches('unrelated', false, rules), false);
});

test('languageShare maps GitHub language names to extension shares', () => {
  const fp = { languages: { ts: 0.4, tsx: 0.1, py: 0.3, md: 0.2 } };
  assert.equal(languageShare(fp, 'TypeScript'), 0.5);
  assert.equal(languageShare(fp, 'Python'), 0.3);
  assert.equal(languageShare(fp, 'Go'), null, 'unknown language → null');
  assert.equal(languageShare(null, 'TypeScript'), null);
  assert.equal(normalizeLanguageName('C++'), 'c++');
  assert.equal(languageMatches('TypeScript', ['ts']), true);
  assert.equal(languageMatches('TypeScript', ['typescript']), true);
  assert.equal(languageMatches('Python', ['ts']), false);
  assert.equal(languageMatches(null, ['ts']), true, 'unknown language is not filtered out');
});

test('subsystemAffinity: fraction of paths in known clusters, neutral without paths', () => {
  const fp = { clusters: { src: 0.6, test: 0.3 } };
  assert.equal(subsystemAffinity(['src/a.ts', 'src/b.ts'], fp).value, 1);
  assert.equal(subsystemAffinity(['src/a.ts', 'other/b.ts'], fp).value, 0.5);
  assert.equal(subsystemAffinity(['top.ts'], fp).value, 0, 'root-level path hits no cluster');
  const neutral = subsystemAffinity([], fp);
  assert.equal(neutral.value, 0.5, 'no paths → neutral, not 0');
  assert.equal(subsystemAffinity([], null).value, 0.5, 'no fingerprint → neutral');
});

test('labelAffinity: configured interests only, graded by hits', () => {
  assert.equal(labelAffinity(['anything'], null), 0.5, 'no fingerprint → neutral');
  assert.equal(labelAffinity(['docs'], { labels: [] }), 0.5, 'no configured labels → neutral');
  assert.equal(labelAffinity(['docs'], { labels: ['good first issue'] }), 0);
  assert.equal(labelAffinity(['good first issue'], { labels: ['good first issue'] }), 0.75);
  assert.equal(
    labelAffinity(['good first issue', 'help wanted'], { labels: ['good first issue', 'help wanted'] }),
    1,
  );
  assert.equal(
    labelAffinity(['GOOD FIRST ISSUE'], { labels: ['good first issue'] }),
    0.75,
    'case-insensitive',
  );
});

test('sizeComfort: closeness of est. footprint to typical change size', () => {
  const fp = { typical: { footprintFiles: 3 } };
  assert.equal(sizeComfort(3, fp), 1, 'exactly typical → 1');
  assert.equal(sizeComfort(null, fp), 0.5, 'unknown footprint → neutral');
  assert.equal(sizeComfort(1, null), 0.5, 'no fingerprint → neutral');
  const tiny = sizeComfort(1, fp);
  const huge = sizeComfort(40, fp);
  assert.ok(tiny > 0 && tiny < 1);
  assert.ok(huge >= 0 && huge < tiny, 'a 40-file issue scores below a 1-file one');
  assert.equal(sizeComfort(162, fp), 0, 'absurdly large → 0');
});

test('matchScore math: 0.4·subsystem + 0.3·language + 0.2·label + 0.1·size-comfort', () => {
  const fp = {
    languages: { ts: 0.5, md: 0.5 },
    clusters: { src: 0.8, test: 0.2 },
    typical: { fileCount: 100, medianFileBytes: 500, footprintFiles: 2 },
    labels: ['good first issue'],
  };
  const perfect = matchScore(
    { paths: ['src/a.ts'], labels: ['good first issue'], touched: 2, repoLanguage: 'TypeScript' },
    fp,
  );
  assert.equal(perfect.parts.subsystem, 1);
  assert.equal(perfect.parts.language, 1, '50% share × 2 = 1');
  assert.equal(perfect.parts.label, 0.75);
  assert.equal(perfect.parts.sizeComfort, 1);
  assert.ok(Math.abs(perfect.total - (0.4 + 0.3 + 0.15 + 0.1)) < 1e-9);

  const worst = matchScore(
    { paths: ['other/a.ts'], labels: ['unrelated'], touched: 40, repoLanguage: 'Go' },
    fp,
  );
  assert.equal(worst.parts.subsystem, 0);
  assert.equal(worst.parts.language, 0.5, 'Go unknown to fingerprint → neutral');
  assert.equal(worst.parts.label, 0);
  assert.ok(worst.parts.sizeComfort < 0.5);
  assert.ok(worst.total < perfect.total);

  const noFp = matchScore({ paths: ['src/a.ts'], labels: [], touched: null, repoLanguage: 'ts' }, null);
  assert.equal(noFp.total, 0.5, 'cold start → neutral 0.5 (README: fall back gracefully)');
  assert.deepEqual(noFp.parts, { subsystem: 0.5, language: 0.5, label: 0.5, sizeComfort: 0.5 });
});

test('matchScore is deterministic and detail strings are stable', () => {
  const fp = {
    languages: { ts: 0.7, md: 0.3 },
    clusters: { src: 1 },
    typical: { fileCount: 50, medianFileBytes: 400, footprintFiles: 1 },
    labels: ['help wanted'],
  };
  const args = {
    paths: ['src/deep/file.ts'],
    labels: ['help wanted'],
    touched: 1,
    repoLanguage: 'TypeScript',
  };
  const a = matchScore(args, fp);
  const b = matchScore(args, fp);
  assert.deepEqual(a, b);
  assert.match(a.detail, /src/);
});
