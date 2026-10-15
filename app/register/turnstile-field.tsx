"use client";

import { useEffect, useRef, useState } from "react";

interface TurnstileApi {
  render: (el: HTMLElement, options: { sitekey: string; callback: (token: string) => void; "expired-callback": () => void }) => string;
}

/**
 * Anti-automation challenge slot for the public registration form. It renders a Cloudflare Turnstile widget only when
 * NEXT_PUBLIC_TURNSTILE_SITE_KEY is configured; otherwise it emits an empty `verification_token`, which the server accepts only where
 * verification is not required (previews/development) and refuses where it is.
 */
export function TurnstileField() {
  const siteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;
  const host = useRef<HTMLDivElement>(null);
  const [token, setToken] = useState("");

  useEffect(() => {
    if (!siteKey || !host.current) return;
    const el = host.current;
    const script = document.createElement("script");
    script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    script.async = true;
    script.onload = () => {
      const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      api?.render(el, { sitekey: siteKey, callback: setToken, "expired-callback": () => setToken("") });
    };
    document.head.appendChild(script);
    return () => script.remove();
  }, [siteKey]);

  return (
    <>
      <input type="hidden" name="verification_token" value={token} />
      {siteKey ? <div ref={host} aria-label="Human verification" /> : null}
    </>
  );
}
