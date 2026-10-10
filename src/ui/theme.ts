import {runtime} from '../runtime.js';

/**
 * The UI's accent colour: the input box, window frames, the selected row and tab. `theme.accent` in
 * config (a colour name or #hex), set by you or a marketplace theme; cyan by default.
 */
export const accent = (): string => runtime.config.theme?.accent || 'cyan';
