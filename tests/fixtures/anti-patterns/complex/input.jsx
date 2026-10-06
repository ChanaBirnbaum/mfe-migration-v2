import React, { useEffect, useState } from 'react';

export function Feed({ ids, token }) {
  const [items, setItems] = useState([]);
  const [user, setUser] = useState(null);

  useEffect(async () => {
    for (const id of ids) {
      const r = await load(id);
      setItems((prev) => [...prev, r]);
    }
  }, [ids]);

  useEffect(async () => {
    if (!token) return;
    const u = await me(token);
    if (!u) return;
    setUser(u);
  }, [token]);

  return <ul>{items.length}{user}</ul>;
}
