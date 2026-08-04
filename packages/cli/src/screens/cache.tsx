import React, { useEffect, useState } from 'react';
import { Text, useApp } from 'ink';
import Spinner from 'ink-spinner';
import { api } from '../api.js';

interface CacheClearResponse {
  ok: boolean;
  namespace: string | null;
  deleted: number;
}

export function CacheClearScreen({ serverUrl }: { serverUrl: string }) {
  const { exit } = useApp();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<CacheClearResponse>(serverUrl, '/cache/clear', {
      method: 'POST',
      body: JSON.stringify({}),
    })
      .then((r) => {
        setMessage(`Cleared ${r.deleted} cache entr${r.deleted === 1 ? 'y' : 'ies'}.`);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setTimeout(() => exit(), 50));
  }, [serverUrl, exit]);

  if (error) return <Text color="red">{error}</Text>;
  if (!message) return <Text><Spinner type="dots" /> clearing cache…</Text>;
  return <Text>{message}</Text>;
}
