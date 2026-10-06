import React, { useEffect, useState } from 'react';

export function Report({ id, run }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(async () => {
    setLoading(true);
    try {
      const res = await fetchReport(id);
      setData(res);
      // setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, [id]);

  return <div onClick={run}>{loading ? '...' : data}{String(error)}</div>;
}
