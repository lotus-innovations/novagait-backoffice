import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@novagait/agent",
    "@novagait/mock-backend",
    "@novagait/pipeline",
  ],
};

export default nextConfig;
