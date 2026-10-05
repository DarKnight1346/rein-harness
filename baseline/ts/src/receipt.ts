import type {Item} from "./item.js";
import {cartLine, cartTotal} from "./cart.js";
import {formatPrice} from "./money.js";

export function receipt(items: Item[]): string {
  const lines = items.map(cartLine);
  return [...lines, `Total: ${formatPrice(cartTotal(items))}`].join("\n");
}
