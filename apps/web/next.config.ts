import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@novagait/agent", "@novagait/mock-backend"],
};

export default nextConfig;
