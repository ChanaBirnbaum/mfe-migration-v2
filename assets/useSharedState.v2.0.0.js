import { useEffect, useState } from 'react';
import { BehaviorSubject } from 'rxjs';

// version 2.0.0
// ===== legacy =====
class SharedState {
  constructor(initialValue) {
    this._state = new BehaviorSubject(initialValue);
  }

  set state(values) {
    this._state.next(values);
  }

  get state() {
    return this._state;
  }
}

function getSharedState(name) {
  window.globalStateHolder = window.globalStateHolder || {};
  if (!window.globalStateHolder[name]) {
    window.globalStateHolder[name] = new SharedState();
  }
  return window.globalStateHolder[name];
}

// ===== zustand config =====
const zustandConfig = {
    userState: {
    selector: (s) => s.user,
    setter: (s) => s.setUser,
  },
  yechidaState: {
    selector: (s) => s.currentYechida,
    setter: (s) => s.setCurrentYechida,
  }

};

// ===== hook =====
const useSharedState = (stateName, initialValue) => {
  const store =
    typeof window !== 'undefined' ? window.__DESKTOP_STORE__ : null;

  const config = zustandConfig[stateName];

  // 🆕 Zustand (reactive)
  if (store && config) {
    try {
      const value = store(config.selector);
      const setter = store(config.setter);

      // אם אין ערך אמיתי → fallback להוסט ישן
      if (value !== undefined ) {
        return [value ?? initialValue, setter];
      }
    } catch {
      // אם משהו נשבר → fallback
    }
  }

  // 🧓 legacy (כמו שהיה)
  const [sharedState, setSharedState] = useState(
    initialValue ?? getSharedState(stateName).state.value
  );

  useEffect(() => {
    const subscription = getSharedState(stateName).state.subscribe({
      next: (state) => {
        setSharedState(state);
      },
    });

    return () => subscription.unsubscribe();
  }, [stateName]);

  const sharedStateSetter = (state) => {
    getSharedState(stateName).state = state;
  };

  return [sharedState, sharedStateSetter];
};

export default useSharedState;
