import { btw } from '../session/btw.js';
import { shellStatusText } from './shells.js';
export function checkQuestion(shell, tail) {
    return `<background_check>
Background command #${shell.id} \`${shell.command}\` (started by you, ${shellStatusText(shell)}) is still running.
Its latest output:
${tail || '(no output)'}

Is it still needed for what the user is doing now? Stop it only if the conversation shows it's no longer
needed (the step it was started for is finished, or it was replaced by a newer run). If the user wanted it
running, or you're not sure, keep it.
Reply with exactly one line: "KEEP: <short reason>" or "STOP: <short reason>".
</background_check>`;
}
/** Parse the fork's answer; anything unclear keeps the command running. */
export function parseVerdict(answer) {
    const m = /^\s*\**\s*(KEEP|STOP)\b\**\s*[:\-–—]?\s*(.*)$/im.exec(answer);
    if (!m)
        return { keep: true, reason: 'no clear answer' };
    return { keep: m[1].toUpperCase() === 'KEEP', reason: m[2].trim().replace(/\*+$/, '') || (m[1] === 'KEEP' ? 'still needed' : 'no longer needed') };
}
export async function stillNeeded(engine, cfg, shells, shell) {
    let answer = '';
    for await (const ev of btw(engine, cfg, checkQuestion(shell, shells.tail(shell, 20))))
        if (ev.type === 'text')
            answer += ev.delta;
    return parseVerdict(answer);
}
/** The agent's own background commands due for a check (every `minutes` of their runtime). */
export function dueForCheck(shells, lastChecked, minutes, now = Date.now()) {
    if (!minutes)
        return [];
    const every = minutes * 60_000;
    return shells.filter((s) => s.background && s.status === 'running' && !s.origin && now - s.startedAt >= every && now - (lastChecked.get(s.id) ?? s.startedAt) >= every);
}
