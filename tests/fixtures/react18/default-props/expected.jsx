import React from 'react';

export function Card({ title, size = 'md', items = [] }) {
  return <div className={size}>{title}{items.length}</div>;
}

const Badge = ({ label: text = 'new' }) => <span>{text}</span>;

export class Legacy extends React.Component {
  render() { return null; }
}
Legacy.defaultProps = { a: 1 };

export { Badge };
