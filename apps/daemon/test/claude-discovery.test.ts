import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeApp } from '../src/runner/apps.js';

function fixture(fn: (root: string, executable: (relative: string) => string) => void) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-discovery-'));
  const oldHome = process.env.HOME, oldPath = process.env.PATH;
  process.env.HOME = root;
  process.env.PATH = path.join(root, 'bin');
  const executable = (relative: string) => {
    const p = path.join(root, relative);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    return p;
  };
  try { fn(root, executable); }
  finally {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    fs.rmSync(root, { recursive: true, force: true });
  }
}
const desktop = 'Library/Application Support/Claude/claude-code';
test('Claude discovery: native install outside daemon PATH', () => fixture((_root, exe) => {
  const native = exe('.local/bin/claude');
  assert.equal(claudeApp.bin(), native);
}));
test('Claude discovery: newest executable desktop version, hashed layout', () => fixture((root, exe) => {
  exe(`${desktop}/2.1.99/claude.app/Contents/MacOS/claude`);
  const expected = exe(`${desktop}/2.1.321/e6736b2d954d/claude.app/Contents/MacOS/claude`);
  const invalid = exe(`${desktop}/2.1.322/hash/claude.app/Contents/MacOS/claude`);
  fs.chmodSync(invalid, 0o644);
  exe(`${desktop}/not-a-version/hash/claude.app/Contents/MacOS/claude`);
  assert.equal(claudeApp.bin(), expected);
}));
test('Claude discovery: PATH takes precedence over native and desktop', () => fixture((_root, exe) => {
  exe('.local/bin/claude');
  exe(`${desktop}/2.1.321/hash/claude.app/Contents/MacOS/claude`);
  const expected = exe('bin/claude');
  assert.equal(claudeApp.bin(), expected);
}));
test('Claude discovery: missing installs return null', () => fixture(() => {
  assert.equal(claudeApp.bin(), null);
}));
