// Colours accepted by /draw: `#RRGGBB` (or `RRGGBB`) or a palette name.
// Same palette as the web canvas (app/frontend/src/canvas/palette.ts).

export const PALETTE = Object.freeze({
  white: 0xffffff,
  lightgray: 0xe4e4e4,
  gray: 0x888888,
  black: 0x222222,
  pink: 0xffa7d1,
  red: 0xe50000,
  orange: 0xe59500,
  brown: 0xa06a42,
  yellow: 0xe5d900,
  lime: 0x94e044,
  green: 0x02be01,
  cyan: 0x00d3dd,
  teal: 0x0083c7,
  blue: 0x0000ea,
  magenta: 0xcf6ee4,
  purple: 0x820080,
});

/** Colour as an integer 0xRRGGBB, or null when the value is not a valid colour. */
export function parseColor(value) {
  if (typeof value !== "string") return null;
  const text = value.trim().toLowerCase();
  if (Object.hasOwn(PALETTE, text)) return PALETTE[text];
  const hex = /^#?([\da-f]{6})$/.exec(text);
  return hex ? parseInt(hex[1], 16) : null;
}
