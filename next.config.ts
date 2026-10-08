import type { NextConfig } from "next";

/**
 * v0.2: a külön Ügyek / Feladatok / Tevékenységek főmenük megszűntek; a régi (v0.1) útvonalak az új felületekre irányítanak.
 * - Ügyek és tevékenységek: az ügyféladatlapokon élnek (Ügyfelek).
 * - Feladatok: az Áttekintés munkapultján és az ügyféladatlapokon.
 */
const nextConfig: NextConfig = {
  async redirects() {
    return [
      { source: "/cases", destination: "/customers", permanent: false },
      { source: "/cases/:id", destination: "/customers", permanent: false },
      { source: "/tasks", destination: "/#feladatok", permanent: false },
      { source: "/activities", destination: "/customers", permanent: false },
    ];
  },
};

export default nextConfig;
