import os from 'node:os';
import path from 'node:path';
import type {ProviderId} from '../providers/types.js';

/** Root of Rein's state. `REIN_HOME` overrides it (tests never touch the real one). */
export function reinHome(): string {
  return process.env.REIN_HOME ?? path.join(os.homedir(), '.rein');
}

export const paths = {
  config: () => path.join(reinHome(), 'config.json'),
  accounts: () => path.join(reinHome(), 'accounts.json'),
  accountHome: (provider: ProviderId, id: string) => path.join(reinHome(), 'accounts', provider, id),
  state: () => path.join(reinHome(), 'state'),
  sessions: () => path.join(reinHome(), 'sessions'),
};
