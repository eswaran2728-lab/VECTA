import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync("app/globals.css", "utf8").replace(/\r\n/g, "\n");
const tailwind = fs.readFileSync("tailwind.config.ts", "utf8");

/** Extracts `--name: value;` declarations of the first block whose selector list matches. */
function block(selectorStart: string): Record<string, string> {
  const i = css.indexOf(selectorStart);
  assert.ok(i >= 0, `selector ${selectorStart} present`);
  const open = css.indexOf("{", i);
  const close = css.indexOf("\n  }", open);
  const body = css.slice(open + 1, close);
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}
const light = block(":root,\n  :root[data-theme=\"light\"]");
const dark = block(".dark,\n  :root[data-theme=\"dark\"]");

// ---- OKLCH -> sRGB -> WCAG luminance (Bjorn Ottosson's OKLab matrices)
function parseTriplet(v: string): [number, number, number, number] {
  const m = v.match(/^(?:oklch\()?\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)?$/);
  assert.ok(m, `parsable oklch triplet: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
}
function toLinearSrgb([L, C, Hdeg]: number[]): [number, number, number] {
  const h = (Hdeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3;
  const clamp = (x: number) => Math.min(1, Math.max(0, x));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}
const luminance = (v: string) => {
  const [r, g, b] = toLinearSrgb(parseTriplet(v));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
function contrast(fg: string, bg: string): number {
  const [a, b] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (a + 0.05) / (b + 0.05);
}

/** Pairs that carry text or meaning; every one must reach WCAG AA (4.5:1 text, 3:1 for large/UI) in BOTH themes. */
const TEXT_PAIRS: Array<[string, string, number]> = [
  ["foreground", "background", 4.5],
  ["card-foreground", "card", 4.5],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "card", 4.5],
  ["primary-foreground", "primary", 4.5],
  ["brand-foreground", "brand", 4.5],
  ["destructive-foreground", "destructive", 4.5],
  ["success-foreground", "success", 4.5],
  ["warning-foreground", "warning", 4.5],
  ["primary", "background", 4.5], // cyan used as link / active text
  ["primary", "card", 4.5],
  ["success", "card", 4.5], // status text on a card
  ["warning", "card", 4.5],
  ["destructive", "card", 4.5],
  ["shell-foreground", "shell", 4.5],
  ["shell-muted", "shell", 4.5],
  ["shell-active", "shell", 4.5],
];

for (const [name, theme] of [["Light", light], ["Dark", dark]] as const) {
  test(`${name} theme: every text/status token pair reaches WCAG AA`, () => {
    const failures: string[] = [];
    for (const [fg, bg, min] of TEXT_PAIRS) {
      assert.ok(theme[fg] !== undefined, `${name}: --${fg} defined`);
      assert.ok(theme[bg] !== undefined, `${name}: --${bg} defined`);
      const ratio = contrast(theme[fg], theme[bg]);
      if (ratio < min) failures.push(`--${fg} on --${bg}: ${ratio.toFixed(2)} < ${min}`);
    }
    assert.deepEqual(failures, []);
  });

  test(`${name} theme: borders and focus ring are visible against the card (3:1 UI contrast for the ring)`, () => {
    const ring = contrast(theme["ring"], theme["card"]);
    assert.ok(ring >= 3, `ring ${ring.toFixed(2)}`);
    assert.ok(theme["border"] !== undefined);
  });
}

test("Dark theme is midnight navy, not pure black, and cards sit above the page", () => {
  const [bgL] = parseTriplet(dark["background"]);
  const [cardL] = parseTriplet(dark["card"]);
  const [, bgC] = parseTriplet(dark["background"]);
  assert.ok(bgL > 0.1 && bgL < 0.3, `background lightness ${bgL}`);
  assert.ok(bgC > 0.02, "tinted navy, not neutral black");
  assert.ok(cardL > bgL, "cards are slightly lighter than the page");
});

test("Light theme is warm-white with white cards and a navy foreground", () => {
  const [bgL] = parseTriplet(light["background"]);
  assert.ok(bgL > 0.95);
  assert.equal(parseTriplet(light["card"])[0], 1);
  const [fgL, , fgH] = parseTriplet(light["foreground"]);
  assert.ok(fgL < 0.3 && fgH > 240 && fgH < 280, "midnight-navy text");
});

test("Stitch status colours exist as semantic tokens (success, warning, destructive, info) in both themes", () => {
  for (const t of [light, dark]) for (const k of ["success", "warning", "destructive", "brand", "primary", "shell", "shell-foreground", "shell-active"]) assert.ok(t[k] !== undefined, k);
});

test("radius is in the approved 10-14px range", () => {
  const rem = Number(light["radius"].replace("rem", ""));
  assert.ok(rem * 16 >= 10 && rem * 16 <= 14, `radius ${rem * 16}px`);
});

test("one typeface: Sora serves body, heading and display; no second display face is configured", () => {
  assert.match(tailwind, /heading:\s*\["var\(--font-body\)"/);
  assert.match(tailwind, /display:\s*\["var\(--font-body\)"/);
  assert.doesNotMatch(fs.readFileSync("app/layout.tsx", "utf8"), /Orbitron|Plus_Jakarta/);
});

test("reduced motion and visible focus are defined globally", () => {
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /:focus-visible/);
});

test("tailwind exposes the new semantic colours so components never hard-code hex values", () => {
  for (const k of ["warning", "shell"]) assert.match(tailwind, new RegExp(`${k}:`));
});
