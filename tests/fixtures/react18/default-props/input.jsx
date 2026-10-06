import React from 'react';

export function Card({ title, size, items }) {
  return <div className={size}>{title}{items.length}</div>;
}

Card.defaultProps = {
  size: 'md',
  items: [],
};

const Badge = ({ label: text }) => <span>{text}</span>;
Badge.defaultProps = { label: 'new', color: 'blue' };

export class Legacy extends React.Component {
  render() { return null; }
}
Legacy.defaultProps = { a: 1 };

export { Badge };
