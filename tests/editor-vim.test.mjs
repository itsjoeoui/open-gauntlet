import assert from 'node:assert/strict';
import test from 'node:test';
import { loadTS } from './load-ts.mjs';

function fixture({ keybindings = 'vim', readOnly = false, failLoad = false } = {}) {
  const calls = { attached: 0, disposed: 0, focused: 0, listenerDisposed: 0, errors: [] };
  let onDispose;
  const editor = {
    focus: () => { calls.focused++; },
    onDidDispose: (callback) => {
      onDispose = callback;
      return { dispose: () => { calls.listenerDisposed++; } };
    },
  };
  let stateIndex = 0;
  let effect;
  const status = {};
  const { default: Editor } = loadTS('../src/components/Editor.tsx', {
    'next/dynamic': { default: () => () => null },
    react: {
      useState: () => stateIndex++ === 0 ? [editor, () => {}] : [null, error => calls.errors.push(error)],
      useRef: () => ({ current: status }),
      useEffect: callback => { effect = callback; },
    },
    'monaco-vim': {
      initVimMode: (receivedEditor, receivedStatus) => {
        if (failLoad) throw new Error('load failed');
        assert.equal(receivedEditor, editor);
        assert.equal(receivedStatus, status);
        calls.attached++;
        return { dispose: () => { calls.disposed++; } };
      },
    },
  });
  Editor({ code: '', language: 'python', readOnly, settings: { keybindings }, onChange: () => {} });
  return { calls, start: () => effect(), disposeEditor: () => onDispose() };
}
const flushImport = () => new Promise(resolve => setImmediate(resolve));

test('Vim attaches to the mounted editor and is disposed when disabled or unmounted', async () => {
  const { calls, start } = fixture();
  const cleanup = start();
  await flushImport();
  assert.equal(calls.attached, 1);
  assert.equal(calls.focused, 1);
  cleanup();
  assert.equal(calls.disposed, 1);
  assert.equal(calls.listenerDisposed, 1);
});

test('default keybindings and read-only editors do not attach Vim', async () => {
  for (const options of [{ keybindings: 'default' }, { readOnly: true }]) {
    const { calls, start } = fixture(options);
    assert.equal(start(), undefined);
    await flushImport();
    assert.equal(calls.attached, 0);
  }
});

test('turning Vim off before its import resolves cancels initialization', async () => {
  const { calls, start } = fixture();
  start()();
  await flushImport();
  assert.equal(calls.attached, 0);
});

test('editor disposal tears down Vim exactly once', async () => {
  const { calls, start, disposeEditor } = fixture();
  const cleanup = start();
  await flushImport();
  disposeEditor();
  cleanup();
  assert.equal(calls.disposed, 1);
});

test('failed Vim initialization reports a retryable error', async () => {
  const { calls, start } = fixture({ failLoad: true });
  const cleanup = start();
  await flushImport();
  assert.match(calls.errors[0], /Toggle it off and on to retry/);
  cleanup();
});
