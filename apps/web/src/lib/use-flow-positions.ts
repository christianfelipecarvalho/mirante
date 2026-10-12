import { useSyncExternalStore } from 'react';
import {
  EMPTY_FLOW_POSITIONS,
  parseFlowPositions,
  updateFlowPositions,
  type StoredFlowPositions,
} from './flow-positions';
import type { FlowPoint } from './flow-viewport';

const key = 'mirante.flow.positions.v1';
const changed = 'mirante-flow-positions';
let raw: string | null | undefined;
let cache: StoredFlowPositions = [];
let memoryOnly = false;
const read = () => {
  if (memoryOnly) return cache;
  try {
    const value = window.localStorage.getItem(key);
    if (value !== raw) {
      raw = value;
      cache = parseFlowPositions(value);
    }
  } catch {
    /* Browser storage can be disabled; this view still works. */
  }
  return cache;
};
const subscribe = (update: () => void) => {
  const storage = (event: StorageEvent) => {
    if (event.key === key || event.key === null) {
      memoryOnly = false;
      update();
    }
  };
  window.addEventListener(changed, update);
  window.addEventListener('storage', storage);
  return () => {
    window.removeEventListener(changed, update);
    window.removeEventListener('storage', storage);
  };
};

/** Share saved positions between compact/detail maps and browser tabs. Write
 * only at the end of a gesture, never on every pointer movement. */
export const useFlowPositions = (sessionId: string) => {
  const positions = useSyncExternalStore(
    subscribe,
    () => read().find((entry) => entry.sessionId === sessionId)?.positions ?? EMPTY_FLOW_POSITIONS,
    () => EMPTY_FLOW_POSITIONS,
  );
  const save = (agentId?: string, point?: FlowPoint) => {
    cache = updateFlowPositions(read(), sessionId, agentId, point);
    raw = JSON.stringify({ version: 1, sessions: cache });
    try {
      window.localStorage.setItem(key, raw);
      memoryOnly = false;
    } catch {
      memoryOnly = true;
    }
    window.dispatchEvent(new Event(changed));
  };
  return {
    positions,
    savePosition: (id: string, point: FlowPoint) => save(id, point),
    resetPositions: () => save(),
  };
};
