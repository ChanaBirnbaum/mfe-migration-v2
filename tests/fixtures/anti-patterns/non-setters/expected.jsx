import React, { useEffect, useState } from 'react';

export function Dashboard({ id }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const res = await fetchDashboard(id);
      setTimeout(() => console.log('loaded'), 0);
      localStorage.setItem('dashboard', JSON.stringify(res));
      if (!cancelled) setData(res);
    };
    run();
    return () => { cancelled = true; };
  }, [id]);

  return <pre>{JSON.stringify(data)}</pre>;
}
