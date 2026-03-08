import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  devIndicators: false,

  // Compress responses for smaller payloads
  compress: true,

  // Generate ETags for caching
  generateEtags: true,

  // Remove X-Powered-By header for cleaner responses
  poweredByHeader: false,

  // Enable View Transitions API for native-like page animations
  experimental: {
    viewTransition: true,
  },
};

export default nextConfig;
