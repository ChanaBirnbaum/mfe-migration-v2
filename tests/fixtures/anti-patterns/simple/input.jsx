import React, { useEffect, useState } from 'react';

export function Details({ id }) {
  const [data, setData] = useState(null);

  useEffect(async () => {
    const data = await fetchData(id);
    setData(data);
  }, [id]);

  return <pre>{JSON.stringify(data)}</pre>;
}
