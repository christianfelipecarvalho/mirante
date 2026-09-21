// The rule lives in `shared`: the daemon uses it too, to decide when reading
// plan limits is worth a process. See ADR-0007.
export { SILENT_AFTER_MS, livenessOf, type Liveness } from '@mirante/shared';
