import React, { useEffect, useState } from 'react';

export function Decode() {
    const [decode, setDecode] = useState(null);
    const [items, setItems] = useState([]);

    useEffect(() => {
        let cancelled = false;
        getDecode()
            .then(res => {
                if (!cancelled) setDecode(res.data)
            })
            .catch(e => {
                console.error(e)
            })
        return () => { cancelled = true; };
    }, [])

    useEffect(() => {
        let cancelled = false;
        getItems().then(res => { if (!cancelled) setItems(res.data); });
        getMore().then((value) => { if (!cancelled) setItems(value); });
        return () => { cancelled = true; };
    }, [])

    useEffect(() => {
        sendAnalytics('page_view')
    }, [])

    return <pre>{JSON.stringify([decode, items])}</pre>;
}
