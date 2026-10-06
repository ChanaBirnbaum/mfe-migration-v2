import React, { useEffect, useState } from 'react';

export function Report({ id, run }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const runEffect = async () => {
      setLoading(true);
      try {
        const res = await fetchReport(id);
        if (!cancelled) setData(res);
        // setError(null);
      } catch (e) {
        if (!cancelled) setError(e);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    runEffect();
    return () => { cancelled = true; };
  }, [id]);

  return <div onClick={run}>{loading ? '...' : data}{String(error)}</div>;
}
