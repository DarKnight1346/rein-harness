import type {Item} from "./item.js";
import {formatPrice} from "./money.js";

export function mostExpensive(items: Item[]): string {
  const top = [...items].sort((a, b) => b.cents - a.cents)[0];
  return top ? `${top.name} (${formatPrice(top.cents)})` : "none";
}

export function cheapItems(items: Item[], limitCents: number): Item[] {
  return items.filter((i) => i.cents < limitCents);
}
