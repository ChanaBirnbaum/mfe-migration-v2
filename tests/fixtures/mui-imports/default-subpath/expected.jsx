import React from 'react';
import Popper from '@mui/material/Popper';
import ImageList from '@mui/material/ImageList';
import ImageListItem from '@mui/material/ImageListItem';

export const B = ({ items }) => (
  <Popper open>
    <ImageList cols={2}>
      {items.map((i) => <ImageListItem key={i}>{i}</ImageListItem>)}
    </ImageList>
  </Popper>
);
