import React from 'react';

interface CardProps {
  title: string;
  children?: React.ReactNode;
}

export const Card: React.FC<CardProps> = ({ title, children }) => <div>{title}{children}</div>;

export const Inline: React.FC<{ label: string; children?: React.ReactNode; }> = ({ label }) => <b>{label}</b>;

export const Bare: React.FC<{ children?: React.ReactNode }> = () => null;

interface WithKids {
  children?: React.ReactNode;
}
export const Ok: React.FC<WithKids> = ({ children }) => <>{children}</>;
