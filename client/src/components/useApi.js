import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api.js';

/** Fetch an API path with optional polling; returns { data, error, loading, reload }. */
export function useApi(path, { poll = 0 } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const d = await api.get(path);
      if (mounted.current) { setData(d); setError(null); }
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    mounted.current = true;
    reload();
    let id;
    if (poll) id = setInterval(reload, poll);
    return () => { mounted.current = false; if (id) clearInterval(id); };
  }, [reload, poll]);

  return { data, error, loading, reload };
}
