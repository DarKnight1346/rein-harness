import {runtime} from '../runtime.js';
import {extensions} from '../extensions/index.js';

/**
 * The UI's accent colour: the input box, window frames, the selected row and tab. `theme.accent` in
 * config (a colour name or #hex), or a marketplace theme item's code; cyan by default.
 */
export const accent = (): string => extensions.theme?.accent || runtime.config.theme?.accent || 'cyan';
