import { useEffect, useState } from 'react';

export function Rows({ filter, onReady }) {
  const [rows, setRows] = useState([]);

  useEffect(async () => {
    const rows = await loadRows(filter);
    setRows(rows);
    if (rows.length) onReady();
    return () => {
      abortAll();
    };
  }, [filter]);

  return rows.length;
}
