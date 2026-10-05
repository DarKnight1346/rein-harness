import type {Item} from "./item.js";
import {formatPrice} from "./money.js";

export function cartTotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.cents, 0);
}

export function cartLine(item: Item): string {
  return `${item.name}: ${formatPrice(item.cents)}`;
}
