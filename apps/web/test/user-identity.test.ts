import test from 'node:test';
import assert from 'node:assert/strict';
import { departmentDisplayName } from '../src/user-identity';

test('account menu displays the resolved department name and never the organization path', () => {
  assert.equal(departmentDisplayName({ departmentName: 'AI 工程团队', orgPath: '/1/12/125/' }), 'AI 工程团队');
  assert.equal(departmentDisplayName({ departmentName: '  核心网控制开发部  ', orgPath: '/1/12/125/' }), '核心网控制开发部');
  assert.equal(departmentDisplayName({ orgPath: '/1/12/125/' }), '未分配部门');
});
