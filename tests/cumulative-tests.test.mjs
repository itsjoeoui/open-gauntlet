import assert from 'node:assert/strict';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { loadTS } from './load-ts.mjs';

const suites = loadTS('../src/lib/test-suites.ts');
// Deliberately shuffled levels and duplicate names exercise ordering and labels.
const problem = {
  className: 'Example',
  levels: [3, 1, 4, 2].map(level => ({
    level,
    testCases: {
      visible: [{ name: 'visible', operations: [['init']], expected: ['null'] }],
      hidden: [{ name: 'hidden', operations: [['init']], expected: ['null'] }],
    },
  })),
};

test('collects only levels up to the selection, labels duplicate names, and leaves source tests unchanged', () => {
  const original = structuredClone(problem);
  for (let level = 1; level <= 4; level++) {
    const tests = suites.getTestsThroughLevel(problem, level);
    for (const visibility of ['visible', 'hidden']) {
      assert.deepEqual(tests[visibility].map(test => test.name),
        Array.from({ length: level }, (_, index) => `L${index + 1}: ${visibility}`));
    }
  }
  assert.deepEqual(problem, original);
});

function routeFixture(route, failingName) {
  let selectedTests = [];
  const submissions = [];
  const updates = [];
  const { POST } = loadTS(`../src/app/api/${route}/route.ts`, {
    '@/lib/test-suites': suites,
    '@/lib/executor': {
      execute: async () => ({ stdout: '', stderr: '', exitCode: 0, executionTime: 1 }),
      getExtension: () => 'py',
    },
    '@/lib/runs': {
      getRun: async () => ({ problemId: 'example', language: 'python', status: 'active', currentLevel: 2, completedLevels: [1], levelTimes: {}, startedAt: Date.now() }),
      saveCode: async () => {}, writeHarness: async () => {}, getRunDir: () => '',
      countLevelSubmissions: async () => submissions.length,
      saveSubmission: async (_id, submission) => { submissions.push(submission); },
      updateRun: async (_id, update) => { updates.push(update); },
    },
    '@/lib/problems': { getProblemById: () => problem },
    '@/lib/harness': {
      generatePythonHarness: (_className, tests) => { selectedTests = tests; return ''; },
      parseHarnessOutput: () => selectedTests.map((test, index) => ({
        index, name: test.name, passed: test.name !== failingName, expected: 'secret', actual: 'secret',
      })),
    },
  });
  return { POST, submissions, updates };
}

for (const level of [1, 2, 4]) {
  test(`Run Tests at level ${level} runs all earlier visible tests and no hidden or future tests`, async () => {
    const { POST, submissions } = routeFixture('run');
    const response = await POST({ json: async () => ({ runId: 'test', code: 'pass', level }) });
    const body = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(body.results.map(result => result.name),
      Array.from({ length: level }, (_, index) => `L${index + 1}: visible`));
    assert.ok(body.results.every(result => !result.hidden));
    assert.equal(submissions.length, 0);
  });
}

test('Run Tests defaults to the saved current level and reports prior-level failures', async () => {
  const { POST } = routeFixture('run', 'L1: visible');
  const body = await (await POST({ json: async () => ({ runId: 'test', code: 'pass' }) })).json();
  assert.equal(body.results.length, 2);
  assert.equal(body.results[0].passed, false);
  assert.equal(body.results[1].passed, true);
});

for (const failingName of [undefined, 'L1: visible', 'L1: hidden']) {
  test(`Submit includes earlier visible and hidden tests; failure=${failingName ?? 'none'}`, async () => {
    const { POST, submissions, updates } = routeFixture('validate', failingName);
    const response = await POST({ json: async () => ({ runId: 'test', code: 'pass', level: 2 }) });
    const body = await response.json();
    assert.deepEqual(body.results.map(result => result.name),
      ['L1: visible', 'L2: visible', 'L1: hidden', 'L2: hidden']);
    assert.deepEqual(body.results.map(result => result.hidden), [false, false, true, true]);
    assert.ok(body.results.slice(2).every(result => result.expected === '' && result.actual === ''));
    assert.equal(body.passed, failingName === undefined);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].level, 2);
    assert.equal(submissions[0].passed, failingName === undefined);
    assert.equal(updates.length, failingName === undefined ? 1 : 0);
  });
}

for (const route of ['run', 'validate']) {
  test(`${route} rejects a nonexistent level`, async () => {
    const { POST } = routeFixture(route);
    const response = await POST({ json: async () => ({ runId: 'test', code: 'pass', level: 5 }) });
    assert.equal(response.status, 404);
  });
}


test('test panel previews cumulative visible tests with level labels', () => {
  const { default: TestPanel } = loadTS('../src/components/TestPanel.tsx', {
    '@/lib/test-suites': suites,
  });
  const html = renderToStaticMarkup(createElement(TestPanel, {
    problem, currentLevel: 2, testResults: null, runOutput: null,
    isRunning: false, locked: false, executionTime: null, runId: 'test', code: '',
  }));
  assert.match(html, /Tests from levels 1–2/);
  assert.match(html, /L1: visible/);
  assert.match(html, /L2: visible/);
  assert.doesNotMatch(html, /L3: visible|L4: visible/);
});

test('superseded tests run before their replacement level and are explicitly listed afterward', () => {
  const evolving = structuredClone(problem);
  const first = evolving.levels.find(level => level.level === 1);
  for (const visibility of ['visible', 'hidden']) {
    first.testCases[visibility][0].supersededAtLevel = 3;
    first.testCases[visibility][0].supersededReason = 'Level 3 changes failure handling.';
  }
  const before = suites.getTestsThroughLevel(evolving, 2);
  assert.equal(before.visible.length, 2);
  assert.equal(before.hidden.length, 2);
  assert.equal(before.superseded.length, 0);
  const after = suites.getTestsThroughLevel(evolving, 3);
  assert.deepEqual(after.visible.map(test => test.name), ['L2: visible', 'L3: visible']);
  assert.deepEqual(after.hidden.map(test => test.name), ['L2: hidden', 'L3: hidden']);
  assert.deepEqual(after.superseded.map(test => test.name), ['L1: visible', 'L1: hidden']);
  const { default: TestPanel } = loadTS('../src/components/TestPanel.tsx', {
    '@/lib/test-suites': suites,
  });
  const html = renderToStaticMarkup(createElement(TestPanel, {
    problem: evolving, currentLevel: 3, testResults: null, runOutput: null,
    isRunning: false, locked: false, executionTime: null, runId: 'test', code: '',
  }));
  assert.match(html, /Superseded earlier tests/);
  assert.match(html, /Level 3 changes failure handling/);
});
