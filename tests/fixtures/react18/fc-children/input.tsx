import React from 'react';

interface CardProps {
  title: string;
}

export const Card: React.FC<CardProps> = ({ title, children }) => <div>{title}{children}</div>;

export const Inline: React.FC<{ label: string }> = ({ label }) => <b>{label}</b>;

export const Bare: React.FC = () => null;

interface WithKids {
  children?: React.ReactNode;
}
export const Ok: React.FC<WithKids> = ({ children }) => <>{children}</>;
