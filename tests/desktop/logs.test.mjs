import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createDesktopLogger } from '../../scripts/desktop-logs.mjs';
import { desktopPaths } from '../../scripts/desktop-paths.mjs';

test('desktop paths separate read-only application files from user data', () => {
  const paths = desktopPaths('C:/Program Files/FocusDesk', 'C:/Users/Test/FocusDesk');
  assert.ok(paths.runtime.endsWith(path.join('runtime', 'node.exe')));
  assert.ok(paths.dataPath.endsWith(path.join('data', 'tasks.json')));
  assert.ok(!paths.dataPath.startsWith(paths.appRoot));
});
test('logs rotate with bounded storage and discard sensitive/unknown details', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'focusdesk-logs-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(tmpdir()));
    assert.ok(path.basename(root).startsWith('focusdesk-logs-')); await rm(root, { recursive: true, force: true });
  });
  const log = createDesktopLogger(root, { maxBytes: 500, archives: 2 });
  for (let i = 0; i < 30; i++) assert.equal(log('BACKEND_EXIT', { exitCode: i, password: 'SECRET', task: 'PRIVATE_TASK', code: 'SAFE' }), true);
  const files = await readdir(root); assert.ok(files.length <= 3);
  for (const file of files) {
    assert.ok((await stat(path.join(root, file))).size <= 500);
    const body = await readFile(path.join(root, file), 'utf8'); assert.doesNotMatch(body, /SECRET|PRIVATE_TASK|password|task/);
    for (const line of body.trim().split('\n')) assert.equal(JSON.parse(line).event, 'BACKEND_EXIT');
  }
});
