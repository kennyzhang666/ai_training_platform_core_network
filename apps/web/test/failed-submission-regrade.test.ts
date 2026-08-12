import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('failed submissions are presented as re-evaluation instead of first evaluation', async () => {
  const source = await readFile(join(root, 'src', 'admin.tsx'), 'utf8');
  const section = source.slice(source.indexOf('function GradingSection'), source.indexOf('function OrganizationSection'));

  assert.match(section, /const failed = submission\.gradingStatus === 'FAILED' \|\| Boolean\(submission\.failureReason\) \|\| submission\.state === 'FAILED'/);
  assert.match(section, /failed \? <button[^>]+onClick=\{\(\) => onSubmission\(submission\)\}>重新评测<\/button>/);
  assert.match(section, /!failed && \['WAITING_TRIGGER', 'RECEIVED'\]\.includes\(submission\.state\)/);
  assert.doesNotMatch(section, /\['WAITING_TRIGGER', 'RECEIVED', 'FAILED'\]/);
});
