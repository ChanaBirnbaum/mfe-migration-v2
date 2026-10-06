import React, { useEffect, useState } from 'react';

export function Dashboard({ id }) {
  const [data, setData] = useState(null);

  useEffect(async () => {
    const res = await fetchDashboard(id);
    setTimeout(() => console.log('loaded'), 0);
    localStorage.setItem('dashboard', JSON.stringify(res));
    setData(res);
  }, [id]);

  return <pre>{JSON.stringify(data)}</pre>;
}
