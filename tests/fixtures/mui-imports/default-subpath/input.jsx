import React from 'react';
import Popper from '@material-ui/core/Popper';
import GridList from '@material-ui/core/GridList';
import GridListTile from '@material-ui/core/GridListTile';

export const B = ({ items }) => (
  <Popper open>
    <GridList cols={2}>
      {items.map((i) => <GridListTile key={i}>{i}</GridListTile>)}
    </GridList>
  </Popper>
);
