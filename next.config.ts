import type { NextConfig } from "next";

/**
 * v0.2: a külön Ügyek / Feladatok / Tevékenységek főmenük megszűntek; a régi (v0.1) útvonalak az új felületekre irányítanak.
 * - Ügyek és tevékenységek: az ügyféladatlapokon élnek (Ügyfelek).
 * - Feladatok: az Áttekintés munkapultján és az ügyféladatlapokon.
 */
/**
 * v1.3 biztonsági fejlécek (GDPR 32. cikk - a feldolgozás biztonsága). A CSP csak azonos eredetű erőforrást enged (külső szkript,
 * betűtípus, kép, keret, mérőkód nincs); a Next.js App Router saját, a HTML-be ágyazott hidratáló szkriptjei miatt a szkriptekre
 * 'unsafe-inline' kell (nonce-alapú CSP-hez dinamikus renderelés és proxy szükséges - lásd docs/V1.3-DATA-PROTECTION.md). Fejlesztői
 * módban a Next hot reload-ja 'unsafe-eval'-t igényel. A Google-belépés űrlapja a saját API-ra küld, amely a Google-hoz irányít át,
 * ezért a form-action a Google belépési oldalát is engedi. HSTS: csak HTTPS-en hat (Vercel); a böngésző 2 évig csak HTTPS-en kapcsolódik.
 */
const dev = process.env.NODE_ENV !== "production";
const CSP = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${dev ? " ws: wss:" : ""}`,
  "frame-src 'none'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self' https://accounts.google.com",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  ...(dev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // A PostgreSQL-meghajtók (pg) és a helyi PGlite nem csomagolódnak be: futásidőben töltődnek be a node_modules-ból.
  serverExternalPackages: ["pg", "@electric-sql/pglite"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
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
