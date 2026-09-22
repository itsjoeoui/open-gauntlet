'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';
import type { OnMount } from '@monaco-editor/react';
import type { SessionSettings } from '@/hooks/useSession';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });

interface EditorProps {
  code: string;
  language: string;
  readOnly: boolean;
  settings: SessionSettings;
  onChange: (value: string) => void;
  onToggleVim: () => void;
}

export default function Editor({ code, language, readOnly, settings, onChange, onToggleVim }: EditorProps) {
  const [editor, setEditor] = useState<Parameters<OnMount>[0] | null>(null);
  const [vimError, setVimError] = useState<string | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const vimEnabled = settings.keybindings === 'vim';

  useEffect(() => {
    if (!editor || !vimEnabled || readOnly) return;
    let cancelled = false;
    let vim: { dispose(): void } | undefined;
    const disposeListener = editor.onDidDispose(() => {
      cancelled = true;
      vim?.dispose();
      vim = undefined;
    });

    import('monaco-vim').then(({ initVimMode }) => {
      if (cancelled) return;
      vim = initVimMode(editor, statusRef.current);
      setVimError(null);
      editor.focus();
    }).catch(() => {
      if (!cancelled) setVimError('Vim could not load. Toggle it off and on to retry.');
    });

    return () => {
      cancelled = true;
      vim?.dispose();
      disposeListener.dispose();
    };
  }, [editor, vimEnabled, readOnly]);

  const monacoLanguage = language === 'python' ? 'python' : 'javascript';

  return (
    <div className="h-full min-h-0 min-w-0 flex flex-col overflow-hidden bg-surface-1">
      <div className="h-8 border-b border-border flex items-center gap-3 px-3 shrink-0 overflow-hidden bg-surface-0">
        <span className="shrink-0 text-xs font-mono text-foreground-secondary">
          solution.{language === 'python' ? 'py' : language === 'javascript' ? 'js' : language}
        </span>
        <div className="min-w-0 flex-1 overflow-hidden text-xs font-mono text-foreground-secondary">
          {vimEnabled && !readOnly && vimError && <span role="alert" className="text-danger">{vimError}</span>}
          <div
            ref={statusRef}
            aria-label="Vim status"
            hidden={!vimEnabled || readOnly}
            className="truncate [&_input]:min-w-0 [&_input]:max-w-full"
          />
        </div>
        <button
          type="button"
          aria-label="Vim mode"
          aria-pressed={vimEnabled}
          disabled={readOnly}
          onClick={onToggleVim}
          className={`shrink-0 px-2 py-0.5 text-xs font-mono border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
            vimEnabled
              ? 'text-accent border-accent/50 bg-accent/10'
              : 'text-foreground-secondary border-border hover:text-foreground'
          }`}
          title="Toggle Vim keybindings (i to insert, Esc for normal mode)"
        >
          Vim {vimEnabled ? 'On' : 'Off'}
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-hidden">
        <MonacoEditor
          height="100%"
          onMount={setEditor}
          language={monacoLanguage}
          value={code}
          theme="vs-dark"
          onChange={(value) => onChange(value ?? '')}
          options={{
            readOnly,
            fontSize: settings.fontSize,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            lineNumbers: 'on',
            renderLineHighlight: 'line',
            automaticLayout: true,
            quickSuggestions: settings.autocomplete,
            suggestOnTriggerCharacters: settings.autocomplete,
            acceptSuggestionOnCommitCharacter: settings.autocomplete,
            tabSize: 4,
            insertSpaces: true,
            cursorBlinking: 'smooth',
            padding: { top: 12 },
          }}
        />
      </div>

    </div>
  );
}
