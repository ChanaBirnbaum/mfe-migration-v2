import React, { useEffect, useState } from 'react';

export function Details({ id }) {
  const [data, setData] = useState(null);

  useEffect(() => {
    const run = async () => {
      const data = await fetchData(id);
      setData(data);
    };
    run();
  }, [id]);

  return <pre>{JSON.stringify(data)}</pre>;
}
