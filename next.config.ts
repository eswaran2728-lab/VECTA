import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
  async rewrites() {
    return [
      {
        source: "/caterlink",
        destination: "/icms/dashboard",
      },
      {
        source: "/caterlink/dashboard",
        destination: "/icms/dashboard",
      },
      {
        source: "/caterlink/transactions",
        destination: "/icms/transactions",
      },
      {
        source: "/caterlink/transactions/:path*",
        destination: "/icms/transactions/:path*",
      },
      {
        source: "/caterlink/vendor-transactions",
        destination: "/icms/vendor-transactions",
      },
      {
        source: "/caterlink/vendor-transactions/:path*",
        destination: "/icms/vendor-transactions/:path*",
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          {
            key: "X-Frame-Options",
            value: "DENY",
          },
          {
            key: "X-Content-Type-Options",
            value: "nosniff",
          },
          {
            key: "Referrer-Policy",
            value: "strict-origin-when-cross-origin",
          },
          {
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(), geolocation=()",
          },
          {
            key: "Content-Security-Policy",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://*.supabase.co; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.supabase.co; font-src 'self' data:; connect-src 'self' https://*.supabase.co wss://*.supabase.co https://*.vercel.app; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self';",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
