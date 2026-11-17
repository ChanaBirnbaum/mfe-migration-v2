import React, { useEffect, useState } from 'react';

export function Decode() {
    const [decode, setDecode] = useState(null);
    const [items, setItems] = useState([]);

    useEffect(async () => {
        getDecode()
            .then(res => {
                setDecode(res.data)
            })
            .catch(e => {
                console.error(e)
            })
    }, [])

    useEffect(async () => {
        getItems().then(res => setItems(res.data));
        getMore().then(setItems);
    }, [])

    useEffect(async () => {
        sendAnalytics('page_view')
    }, [])

    return <pre>{JSON.stringify([decode, items])}</pre>;
}
