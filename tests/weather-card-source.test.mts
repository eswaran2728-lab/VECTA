import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const card = fs.readFileSync("components/weather/StationWeatherCard.tsx", "utf8");
const fab = fs.readFileSync("components/wois/WoisFloatingTrigger.tsx", "utf8");

test("the card is a server component and never calls a provider or reads the key in the browser", () => {
  assert.doesNotMatch(card, /^"use client"/m);
  assert.doesNotMatch(card, /WEATHERAPI_API_KEY|api\.weatherapi\.com|process\.env/);
});

test("the two sources are labelled separately and fail independently", () => {
  assert.match(card, /Hourly · WeatherAPI\.com/);
  assert.match(card, /Daily · MET Malaysia/);
  assert.match(card, /Promise\.all\(\[forecastService\.get\(station\), hourlyService\.get\(station\)\]\)/);
  assert.match(card, /not live observations and not aviation weather clearance/);
});

test("the strip is swipeable, keyboard focusable and described for screen readers; nothing is hard-coded from the mockup", () => {
  assert.match(card, /overflow-x-auto/);
  assert.match(card, /snap-x/);
  assert.match(card, /tabIndex=\{0\}/);
  assert.match(card, /aria-label="Hourly forecast\. Scroll sideways/);
  assert.doesNotMatch(card, />s*(58|49|32|31|30|29|28)°?%?s*</);
  assert.match(card, /w-\[34%\]/, "about two and a half tiles show on a 390px phone");
});

test("a loading skeleton reserves the space, and the card has a compact details disclosure", () => {
  assert.match(card, /export function StationWeatherSkeleton/);
  assert.match(card, /aria-busy="true"/);
  assert.match(card, /<details/);
  for (const page of ["app/(avsec)/avsec/my-dashboard/page.tsx", "app/(avsec)/avsec/duty/page.tsx", "app/(avsec)/avsec/bay-board/page.tsx"]) {
    assert.match(fs.readFileSync(page, "utf8"), /<Suspense fallback=\{<StationWeatherSkeleton \/>\}>/, page);
  }
});

test("the floating AI button is compact, sits above the bottom navigation and steps away from warnings and actions", () => {
  assert.match(fab, /\[role="alert"\]/);
  assert.match(fab, /\.vecta-btn-primary/);
  assert.match(fab, /hidden"/);
  assert.match(fab, /bottom-\[calc\(5\.25rem\+env\(safe-area-inset-bottom\)\)\]/);
  assert.match(fab, /aria-label="Open W\.O\.I\.S AI Assistant"/);
});
