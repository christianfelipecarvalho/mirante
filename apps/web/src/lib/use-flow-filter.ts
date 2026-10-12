import { useSyncExternalStore } from 'react';

const key = 'mirante.flow.onlyWorking';
const changed = 'mirante-flow-filter';
let fallback = false;
let memoryOnly = false;
const read = () => {
  if (memoryOnly) return fallback;
  try {
    return window.localStorage.getItem(key) === 'true';
  } catch {
    return fallback;
  }
};
const subscribe = (update: () => void) => {
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) update();
  };
  window.addEventListener(changed, update);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(changed, update);
    window.removeEventListener('storage', storage);
  };
};

/** One preference across the compact map, session detail, and browser tabs. */
export const useFlowFilter = () => {
  const onlyWorking = useSyncExternalStore(subscribe, read, () => false);
  const setOnlyWorking = (value: boolean) => {
    fallback = value;
    try {
      window.localStorage.setItem(key, String(value));
      memoryOnly = false;
    } catch {
      memoryOnly = true;
    }
    window.dispatchEvent(new Event(changed));
  };
  return { onlyWorking, setOnlyWorking };
};
