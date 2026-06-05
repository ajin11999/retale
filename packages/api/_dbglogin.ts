import * as auth from "./src/services/auth-service.ts";
try {
  const r = await auth.login({ username: "manager", password: "manager12345" });
  console.log("OK", JSON.stringify(r.kind));
} catch (e) {
  console.error("THREW:", e);
}
process.exit(0);
