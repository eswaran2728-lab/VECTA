import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // firebase-admin's dependency chain (jwks-rsa -> jose) mixes ESM-only
  // and CJS builds in a way Next's bundler resolves incorrectly for
  // serverless functions (ERR_REQUIRE_ESM at runtime). Excluding it from
  // bundling lets Node's own require()/import resolution handle it
  // correctly instead — the standard fix for firebase-admin + Next.js.
  serverExternalPackages: ["firebase-admin"],
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "*.supabase.co",
      },
    ],
  },
  // The completed-form PDF generators (src/lib/completed-form-pdf*.ts)
  // read the official form templates from disk at runtime — ensure
  // Vercel's serverless function bundling includes them (they aren't
  // otherwise reachable by static import-tracing).
  outputFileTracingIncludes: {
    "/**": ["./templates/forms/**/*.pdf"],
  },
};

export default nextConfig;
