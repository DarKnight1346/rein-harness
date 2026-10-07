/**
 * Relative cost tier (1 = cheapest … 6 = most expensive) from a model's own description, as the
 * CLIs report it (neither exposes prices). No model names: only how each CLI describes its models.
 */
export function tierFrom(description = '') {
    const s = description.toLowerCase();
    if (/frontier|toughest|hardest|most capable|most demanding|most intelligent/.test(s))
        return 6;
    if (/fastest|quick answers|affordable|cheap|\b(mini|nano|lite)\b/.test(s))
        return 1;
    if (/complex/.test(s))
        return 5;
    if (/workhorse|everyday/.test(s))
        return 4;
    if (/balanced|routine/.test(s))
        return 3;
    if (/efficient|simpler|easier|straightforward|\bfast\b/.test(s))
        return 2;
    return 4;
}
