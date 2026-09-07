import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkTypecheck } from './check-typecheck.mjs';

/** @param {import('node:test').TestContext} t @param {Record<string,unknown>} compilerOptions */
function fixture(t, compilerOptions = { strict: true }) {
  const root = mkdtempSync(join(tmpdir(), 'typecheck-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions, include: ['source.ts'] }));
  writeFileSync(join(root, 'source.ts'), 'export const value = 1;\n');
  return root;
}

test('rejects disabled checking including inherited configuration', t => {
  for (const compilerOptions of [{ strict: false }, {}, { strict: true, noCheck: true }]) {
    const root = fixture(t, compilerOptions);
    assert.throws(() => checkTypecheck(root), /strict must be true|noCheck must not be true/);
  }
  const root = fixture(t);
  writeFileSync(join(root, 'base.json'), JSON.stringify({ compilerOptions: { strict: false, noCheck: true } }));
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ extends: './base.json', include: ['source.ts'] }));
  assert.throws(() => checkTypecheck(root), /strict must be true[\s\S]*noCheck must not be true/);
});

test('rejects real line and block suppression comments with source locations', t => {
  const root = fixture(t);
  for (const comment of ['// @ts-nocheck', '/* @ts-ignore */', '/**\n * @ts-nocheck\n */', '// @ts-ignoreTrailingText']) {
    writeFileSync(join(root, 'source.ts'), `${comment}\nexport const value = 1;\n`);
    assert.throws(() => checkTypecheck(root), /source\.ts:\d+:\d+: forbidden type-check suppression/);
  }
});

test('does not treat strings, template text or regular expressions as comments', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'source.ts'), [
    'const a = "// @ts-nocheck";',
    "const b = '/* @ts-ignore */';",
    'const c = `prefix ${a} // @ts-nocheck ${b} /* @ts-ignore */`;',
    'const d = /[/*] @ts-ignore/;',
    '// A normal comment is permitted.',
  ].join('\n'));
  assert.deepEqual(checkTypecheck(root), { files: 1 });
});

test('checks comments inside template expressions and after regular expressions', t => {
  const root = fixture(t);
  for (const source of [
    'const value = `${ /* @ts-ignore */ 1 }`;',
    'const value = /test/; // @ts-nocheck\n',
  ]) {
    writeFileSync(join(root, 'source.ts'), source);
    assert.throws(() => checkTypecheck(root), /forbidden type-check suppression/);
  }
});

test('checks deployment JavaScript without requiring its intentional non-strict migration setting', t => {
  const root = fixture(t);
  const deployment = { compilerOptions: { allowJs: true, checkJs: true, strict: false }, include: ['deploy.mjs'] };
  writeFileSync(join(root, 'tsconfig.deployment.json'), JSON.stringify(deployment));
  writeFileSync(join(root, 'deploy.mjs'), 'export const value = 1;\n');
  assert.deepEqual(checkTypecheck(root), { files: 2 });
  writeFileSync(join(root, 'deploy.mjs'), '// @ts-ignore\nexport const value = 1;\n');
  assert.throws(() => checkTypecheck(root), /deploy\.mjs:1:4: forbidden type-check suppression/);
  deployment.compilerOptions.checkJs = false;
  writeFileSync(join(root, 'tsconfig.deployment.json'), JSON.stringify(deployment));
  assert.throws(() => checkTypecheck(root), /checkJs must be true/);
});

test('rejects malformed configuration instead of reporting an empty successful scan', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'tsconfig.json'), '{ invalid JSON');
  assert.throws(() => checkTypecheck(root), /Type-check guard failed/);
});
