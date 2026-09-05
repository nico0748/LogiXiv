import { useEffect, useState } from 'react';
import { Library } from './Library.tsx';
import { Reader } from './Reader.tsx';

/**
 * ルーティングは location.hash だけで足りる。
 * ローカルで開く 2 画面のアプリにルータライブラリを入れる理由がない。
 */
function documentIdFromHash(): string | null {
  const match = /^#\/d\/([A-Za-z0-9_-]{1,64})$/.exec(window.location.hash);
  return match?.[1] ?? null;
}

export function App(): React.JSX.Element {
  const [documentId, setDocumentId] = useState<string | null>(documentIdFromHash);

  useEffect(() => {
    const onChange = (): void => setDocumentId(documentIdFromHash());
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);

  if (documentId) {
    return (
      <Reader
        documentId={documentId}
        onBack={() => {
          window.location.hash = '';
        }}
      />
    );
  }

  return (
    <Library
      onOpen={(id) => {
        window.location.hash = `#/d/${id}`;
      }}
    />
  );
}
