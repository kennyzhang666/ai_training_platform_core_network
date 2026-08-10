import assert from 'node:assert/strict';
import test from 'node:test';
import { submissionSourceAvailability } from '../src/submission-source';

test('上传交付场次只允许选择上传方式', () => {
  assert.deepEqual(submissionSourceAvailability('UPLOAD'), {
    selected: 'UPLOAD',
    uploadEnabled: true,
    gitEnabled: false,
  });
});

test('Git 交付场次只允许选择 Git 方式', () => {
  assert.deepEqual(submissionSourceAvailability('GIT_REF'), {
    selected: 'GIT_REF',
    uploadEnabled: false,
    gitEnabled: true,
  });
});

test('场次尚未加载时不开放任何交付方式', () => {
  assert.deepEqual(submissionSourceAvailability(undefined), {
    selected: undefined,
    uploadEnabled: false,
    gitEnabled: false,
  });
});
