import { useEffect, useState } from 'react';

export function Rows({ filter, onReady }) {
  const [rows, setRows] = useState([]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const rows = await loadRows(filter);
      if (!cancelled) setRows(rows);
      if (rows.length) onReady();
    };
    run();
    return () => {
      cancelled = true;
      abortAll();
    };
  }, [filter]);

  return rows.length;
}
