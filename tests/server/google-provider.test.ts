import { expect, it } from "vitest";
import * as oidc from "openid-client";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { createGoogleProvider } from "@/server/auth/google";

it("validates Google ID-token signatures, issuer, audience, nonce and expiry before trusting claims", async () => {
  const issuer = "https://accounts.google.com";
  const settings = { origin: "https://crm.example.test", clientId: "unit.apps.googleusercontent.com", clientSecret: "test-only" };
  const flow = { state: "expected-state", nonce: "expected-nonce", code_verifier: oidc.randomPKCECodeVerifier() };
  const keys = await generateKeyPair("RS256");
  const wrongKeys = await generateKeyPair("RS256");
  const jwk = { ...await exportJWK(keys.publicKey), kid: "unit-key", use: "sig", alg: "RS256" };
  let idToken = "";
  let verifier = "";
  const config = new oidc.Configuration({
    issuer, authorization_endpoint: "https://oidc.example.test/authorize",
    token_endpoint: "https://oidc.example.test/token", jwks_uri: "https://oidc.example.test/jwks",
    id_token_signing_alg_values_supported: ["RS256"],
  }, settings.clientId, settings.clientSecret);
  // Network is replaced only inside this test. Production always discovers Google's HTTPS endpoints.
  config[oidc.customFetch] = async (url, options) => {
    if (String(url).endsWith("/jwks")) return Response.json({ keys: [jwk] });
    verifier = new URLSearchParams(options?.body as string).get("code_verifier") ?? "";
    return Response.json({ access_token: "test-access-token", token_type: "Bearer", id_token: idToken });
  };
  oidc.enableNonRepudiationChecks(config);
  const provider = createGoogleProvider(async () => config);
  const callback = new URL(settings.origin + "/api/auth/google/callback?code=test-code&state=" + flow.state);
  const sign = async (overrides: Record<string, unknown> = {}, badSignature = false) => new SignJWT({
    iss: issuer, sub: "verified-google-sub", aud: settings.clientId,
    iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    nonce: flow.nonce, email: "allowed@example.test", email_verified: true, ...overrides,
  }).setProtectedHeader({ alg: "RS256", kid: "unit-key" }).sign(badSignature ? wrongKeys.privateKey : keys.privateKey);

  const authorization = await provider.authorize(settings, flow);
  expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
  expect(authorization.searchParams.get("code_challenge")).toBe(await oidc.calculatePKCECodeChallenge(flow.code_verifier));
  expect(authorization.searchParams.get("redirect_uri")).toBe(settings.origin + "/api/auth/google/callback");
  idToken = await sign();
  expect(await provider.exchange(settings, callback, flow)).toEqual({ sub: "verified-google-sub", email: "allowed@example.test", email_verified: true });
  expect(verifier).toBe(flow.code_verifier);
  for (const bad of [
    { aud: "another-client" }, { nonce: "another-browser" },
    { iss: "https://attacker.example.test" }, { exp: Math.floor(Date.now() / 1000) - 300 },
  ]) {
    idToken = await sign(bad);
    await expect(provider.exchange(settings, callback, flow)).rejects.toThrow();
  }
  idToken = await sign({}, true);
  await expect(provider.exchange(settings, callback, flow)).rejects.toThrow();
  idToken = await sign();
  await expect(provider.exchange(settings, callback, { ...flow, state: "wrong-state" })).rejects.toThrow();
});
