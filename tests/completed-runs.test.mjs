import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import ts from 'typescript';

const require = createRequire(import.meta.url);
function loadTS(file, mocks = {}) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX },
  });
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', outputText)(
    (name) => name in mocks ? mocks[name] : require(name), loaded, loaded.exports,
  );
  return loaded.exports;
}
const { reducer } = loadTS('../src/hooks/useSession.ts');
const problem = { id: 'test', levels: [1, 2, 3, 4], starterCode: { python: '' } };
function sessionState(finished = false) {
  return reducer({}, {
    type: 'HYDRATE', problem, runId: 'test', finished,
    session: { startedAt: Date.now(), currentLevel: 4, completedLevels: [1, 2, 3], levelTimes: { 1: 0, 2: 10, 3: 20 }, code: '', submissions: [] },
  });
}
function submit(state, passed) {
  return reducer(state, { type: 'SUBMIT_RESULT', level: 4, result: { passed, results: [], stdout: '', stderr: '' } });
}

test('completion survives repeated passing and failing submissions and timer expiry', () => {
  const completed = submit(sessionState(), true);
  assert.equal(completed.finished, true);
  const retry = submit(submit(completed, false), true);
  assert.equal(retry.finished, true);
  assert.deepEqual(retry.session.levelTimes, completed.session.levelTimes);
  assert.deepEqual(retry.session.completedLevels, [1, 2, 3, 4]);
  assert.equal(retry.session.submissions.length, 3);
  assert.equal(retry.testResultsPassed, true);
  assert.equal(reducer(retry, { type: 'TIMER_EXPIRE' }).expired, false);
});

test('reopened completed runs stay finished after a failed retry', () => {
  const state = submit(sessionState(true), false);
  assert.equal(state.finished, true);
  assert.equal(state.testResultsPassed, false);
});

test('a zero-second first pass is preserved on retry', () => {
  const state = sessionState(true);
  state.session.levelTimes[4] = 0;
  assert.equal(submit(state, true).session.levelTimes[4], 0);
});

test('finished runs retain their original score time, including legacy runs', async () => {
  for (const finalTime of [0, 30]) {
    const run = { status: 'finished', startedAt: 1, timeLimit: 5400, completedLevels: [1, 2, 3, 4], levelTimes: { 4: finalTime } };
    const { calculateScore } = loadTS('../src/lib/runs.ts', {
      './executor': {},
      'node:fs/promises': { readFile: async () => JSON.stringify(run), readdir: async () => [] },
    });
    assert.equal((await calculateScore('test', 4)).totalTime, finalTime);
  }
});

test('validation records the first finish and keeps it through successful and failed retries', async () => {
  let run = {
    status: 'active', problemId: 'test', language: 'python', startedAt: Date.now(),
    completedLevels: [1, 2, 3], levelTimes: { 1: 0, 2: 10, 3: 20 },
  };
  let passed = true;
  const saved = [];
  const updates = [];
  const { POST } = loadTS('../src/app/api/validate/route.ts', {
    '@/lib/executor': { execute: async () => ({ stdout: '', stderr: '' }), getExtension: () => 'py' },
    '@/lib/runs': {
      getRun: async () => run,
      saveCode: async () => {}, writeHarness: async () => {}, getRunDir: () => '',
      countLevelSubmissions: async () => saved.length,
      saveSubmission: async (_id, submission) => { saved.push(submission); },
      updateRun: async (_id, update) => { updates.push(update); run = { ...run, ...update }; },
    },
    '@/lib/problems': {
      getProblemById: () => ({ levels: [1, 2, 3, 4].map(level => ({ level, testCases: { visible: [], hidden: [] } })) }),
    },
    '@/lib/harness': { generatePythonHarness: () => '', parseHarnessOutput: () => [{ index: 0, name: 'retry', passed }] },
  });
  for (const verdict of [true, false, true]) {
    passed = verdict;
    const response = await POST({ json: async () => ({ runId: 'test', code: 'pass', level: 4 }) });
    assert.equal((await response.json()).passed, verdict);
    assert.equal(run.status, 'finished');
  }
  assert.equal(saved.length, 3);
  assert.equal(new Set(saved.map(submission => submission.id)).size, 3);
  assert.equal(updates.length, 1);
  assert.equal(typeof run.finishedAt, 'number');
  assert.deepEqual(run.completedLevels, [1, 2, 3, 4]);
  assert.equal(run.levelTimes[1], 0);
});

test('completed runs can invoke both execution actions; locked sessions cannot', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    json: async () => ({ passed: true, results: [], stdout: '', stderr: '' }),
  }));
  for (const lock of [null, 'expired', 'paused', 'reviewMode', 'isRunning', 'isSubmitting']) {
    const state = sessionState(true);
    state.session.code = 'pass';
    if (lock) state[lock] = true;
    const actions = [];
    const { useSession: invokeMockedSession } = loadTS('../src/hooks/useSession.ts', {
      react: {
        useReducer: () => [state, (action) => actions.push(action)],
        useCallback: (callback) => callback,
        useEffect: () => {},
        useRef: (current) => ({ current }),
      },
    });
    const session = invokeMockedSession();
    await session.runCode();
    await session.submitLevel();
    assert.deepEqual(actions.filter(a => a.type.endsWith('_START')).map(a => a.type),
      lock ? [] : ['RUN_START', 'SUBMIT_START']);
  }
});

test('completed runs show stats and an enabled submit button', () => {
  const { default: BottomBar } = loadTS('../src/components/BottomBar.tsx');
  const html = renderToStaticMarkup(createElement(BottomBar, {
    currentLevel: 4, totalLevels: 4, finished: true, locked: false,
    isSubmitting: false, saveStatus: 'saved',
  }));
  assert.match(html, /View Results/);
  assert.match(html, /SUBMIT L4/);
  assert.doesNotMatch(html, /disabled=""/);
});
