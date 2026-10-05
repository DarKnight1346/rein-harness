import type {UsageRow} from '../accounts/usage.js';
import type {UpdateLine} from '../commands/update.js';
import type {ContextReport} from '../session/context.js';
import type {ChatEntry, NewEntry} from './useChat.js';

/** One item of the visible transcript (both renderers). */
export type Entry =
  /** `images`: files pasted or dropped into a message you sent, shown under it where the terminal can. */
  | {id: number; kind: 'banner' | 'user' | 'info' | 'error'; text: string; images?: string[]}
  | {id: number; kind: 'usage'; rows: UsageRow[]; jev: boolean}
  | {id: number; kind: 'update'; line: UpdateLine}
  | {id: number; kind: 'context'; report: ContextReport}
  | ChatEntry;

export type AddEntry = (e: NewEntry<Entry>) => void;
