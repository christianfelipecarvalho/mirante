import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Where the built board lives.
 *
 * Two layouts have to work: the published package, which carries the assets in
 * `web/`, and this repository, where they are built into `apps/web/dist`.
 * Running from a clone is how contributors will use it, so it is not an
 * afterthought.
 */
export const findWebRoot = (): string | undefined => {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'web'),
    join(here, '..', '..', 'web'),
    resolve(here, '..', '..', '..', 'apps', 'web', 'dist'),
    resolve(here, '..', '..', '..', '..', 'apps', 'web', 'dist'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'index.html')));
};
