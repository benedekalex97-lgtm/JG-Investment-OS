import type { NextConfig } from "next";

/**
 * v0.2: a külön Ügyek / Feladatok / Tevékenységek főmenük megszűntek; a régi (v0.1) útvonalak az új felületekre irányítanak.
 * - Ügyek és tevékenységek: az ügyféladatlapokon élnek (Ügyfelek).
 * - Feladatok: az Áttekintés munkapultján és az ügyféladatlapokon.
 */
const nextConfig: NextConfig = {
  // A PostgreSQL-meghajtók (pg) és a helyi PGlite nem csomagolódnak be: futásidőben töltődnek be a node_modules-ból.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
  async redirects() {
    return [
      { source: "/cases", destination: "/customers", permanent: false },
      { source: "/cases/:id", destination: "/customers", permanent: false },
      { source: "/tasks", destination: "/#feladatok", permanent: false },
      { source: "/activities", destination: "/customers", permanent: false },
      // v1.1: az Adatkezelés a Beállítások alá került; a v1.0 hivatkozások (könyvjelzők) tovább működnek. Az API (/api/data/*) változatlan.
      { source: "/data", destination: "/settings/data", permanent: false },
      { source: "/data/:path*", destination: "/settings/data/:path*", permanent: false },
    ];
  },
};

export default nextConfig;
