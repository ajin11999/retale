// Throwaway smoke test for the auth lib. Run:
//   bun run scripts/smoke-auth.ts
// Assumes a clean `sessions`/`users` state is not required — it uses a
// unique username per run.
import { isBootstrapNeeded, login, logout, refresh, registerUser } from "../src/services/auth-service.ts";
import { verifyAccessToken } from "../src/lib/jwt.ts";

const username = `smoke_${Date.now()}`;

console.log("bootstrap needed:", await isBootstrapNeeded());

const user = await registerUser({ username, password: "hunter2", name: "Smoke Test" });
console.log("registered:", { id: user.id, username: user.username, isRoot: user.isRoot });

const { tokens } = await login({ username, password: "hunter2" });
console.log("login ok, access claims:", await verifyAccessToken(tokens.accessToken));

const bad = await login({ username, password: "wrong" }).then(() => "NO ERROR (BUG)").catch((e) => e.code);
console.log("bad password rejected:", bad);

const rotated = await refresh({ refreshToken: tokens.refreshToken });
console.log("refresh ok, new token differs:", rotated.tokens.refreshToken !== tokens.refreshToken);

const reuse = await refresh({ refreshToken: tokens.refreshToken }).then(() => "NO ERROR (BUG)").catch((e) => e.code);
console.log("stale refresh token rejected:", reuse);

await logout(rotated.tokens.refreshToken);
const afterLogout = await refresh({ refreshToken: rotated.tokens.refreshToken }).then(() => "NO ERROR (BUG)").catch((e) => e.code);
console.log("refresh after logout rejected:", afterLogout);

process.exit(0);
