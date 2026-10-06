import React, { useEffect, useState } from 'react';

export function Details({ id }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const data = await fetchData(id);
      if (!cancelled) setData(data);
    };
    run();
    return () => { cancelled = true; };
  }, [id]);

  return <pre>{JSON.stringify(data)}</pre>;
}
