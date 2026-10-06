// TEST STAND-IN ONLY – not the real useSharedState v2.0.0.
// The real asset must be placed at assets/useSharedState.v2.0.0.js.
import { useState } from 'react';

export default function useSharedState(stateName, initialValue) {
  const [value, setValue] = useState(initialValue);
  return [value, setValue];
}
