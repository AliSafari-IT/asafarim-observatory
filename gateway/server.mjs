import http from "node:http";
import { isIP } from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { createNodeAuth } from "@asafarim/auth-runtime/node";
import { createRedisStore } from "@asafarim/auth-runtime/stores/redis";
import Redis from "ioredis";
import { createHmac } from "node:crypto";
import { AccessStore, AccessError, identityProfile } from "./access.mjs";
import { accessPage, formBody } from "./access-pages.mjs";
import { SmtpClient } from "./smtp.ts";

const escape = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const page = (title, content) =>
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Observatory</title><style>body{margin:0;background:#11171c;color:#e3e8e9;font:16px system-ui;min-height:100vh;display:grid;place-items:center}main{max-width:760px;margin:24px;padding:32px;border:1px solid #35434b;border-radius:12px;background:#171f25}p{line-height:1.7;color:#aebbc4}a,button{display:inline-block;background:#7fd5ba;color:#11171c;border:0;border-radius:6px;padding:12px 18px;font:inherit;cursor:pointer;text-decoration:none}form{margin-top:18px}textarea{display:block;width:100%;box-sizing:border-box;margin:12px 0;padding:12px;font:inherit}article{border-top:1px solid #35434b;margin-top:24px;padding-top:12px}button{margin-top:8px}small{color:#93a1ad}a:focus-visible,button:focus-visible{outline:3px solid #e9ba70;outline-offset:4px}</style><main><small>ASafariM OBSERVATORY</small><h1>${escape(title)}</h1>${content}</main></html>`;

export function createGateway({
  auth,
  origin,
  upstream = "http://127.0.0.1:8085",
  access,
  profile = identityProfile,
  vpsEnabled = false,
}) {
  const expected = new URL(origin);
  const primary = new URL(upstream);
  if (primary.origin !== "http://127.0.0.1:8085")
    throw new Error("Invalid private API origin");
  const send = (res, status, body, type = "text/html; charset=utf-8") => {
    res.writeHead(status, {
      "content-type": type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(body);
  };
  return http.createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (req.url === "/healthz" && req.method === "GET")
      return send(
        res,
        200,
        JSON.stringify({
          status: "ok",
          version: "0.2.2",
          gateway_version: "0.2.0",
        }),
        "application/json",
      );
    if (
      req.headers.host !== expected.host ||
      !req.url?.startsWith("/") ||
      req.url.startsWith("//") ||
      req.url.length > 4096
    )
      return send(res, 400, "Invalid request.", "text/plain");
    const pathname = new URL(req.url, origin).pathname;
    if (!["GET", "HEAD", "POST"].includes(req.method))
      return send(res, 405, "Method not allowed.", "text/plain");
    if (
      req.method === "POST" &&
      pathname !== "/auth/backchannel-logout" &&
      req.headers.origin !== origin
    )
      return send(res, 403, "Origin check failed.", "text/plain");
    try {
      if (await auth.handle(req, res)) return;
      if (pathname === "/login") {
        if (req.method !== "GET")
          return send(res, 405, "Method not allowed.", "text/plain");
        return send(
          res,
          200,
          page(
            "Your workspace, in perspective.",
            `<p>Sign in with your ASafariM account to view saved workspace observations and AI summaries. Every registered ASafariM account has viewer access. Admin tools require approval.</p><a href="${escape(auth.startUrl({ returnTo: "/" }))}">Sign in with ASafariM</a>`,
          ),
        );
      }
      let session;
      try {
        session = await auth.require(req);
      } catch (error) {
        if (error?.status === 401) {
          if (pathname.startsWith("/api/") || pathname === "/auth/context")
            return send(
              res,
              401,
              JSON.stringify({
                error: {
                  code: "sign_in_required",
                  message: "Sign in to continue.",
                },
              }),
              "application/json",
            );
          res.writeHead(303, { location: "/login" });
          res.end();
          return;
        }
        if (error?.status === 403)
          return send(
            res,
            403,
            page(
              "Access is restricted.",
              "<p>Your account does not have access to this private workspace.</p>",
            ),
          );
        return send(
          res,
          503,
          page(
            "Sign-in service unavailable.",
            "<p>Access could not be verified. Try again shortly.</p>",
          ),
        );
      }
      const requestUrl = new URL(req.url, origin);
      const workspace = requestUrl.searchParams.get("workspace") ?? "local";
      if (
        pathname.startsWith("/api/") &&
        (requestUrl.searchParams.getAll("workspace").length > 1 ||
          !["local", ...(vpsEnabled ? ["vps"] : [])].includes(workspace))
      ) {
        return send(
          res,
          400,
          JSON.stringify({ error: { message: "Unknown workspace." } }),
          "application/json",
        );
      }
      const target =
        workspace === "vps" && pathname.startsWith("/api/")
          ? new URL("http://127.0.0.1:8086")
          : primary;
      requestUrl.searchParams.delete("workspace");
      const subject = session.view?.identityKey.sub;
      let context;
      // Provider roles are checked live for every access-management or privileged action.
      if (
        access &&
        (pathname === "/auth/context" ||
          pathname === "/account" ||
          pathname.startsWith("/access") ||
          req.method === "POST")
      ) {
        const info = await profile(session);
        access.profile(subject, info.email);
        context = access.context(subject, info.reviewer);
      }
      if (pathname === "/auth/context")
        return send(
          res,
          200,
          JSON.stringify({
            authenticated: true,
            workspaces: [
              { id: "local", label: "Laptop workspace" },
              ...(vpsEnabled ? [{ id: "vps", label: "VPS workspace" }] : []),
            ],
            csrf: session.csrf,
            ...context,
          }),
          "application/json",
        );
      if (pathname.startsWith("/access") && access) {
        if (req.method === "POST") {
          const form = await formBody(req);
          auth.runtime.verifyCsrf(session, form.get("csrf"));
          if (pathname === "/access/continue") access.onboard(subject);
          else if (pathname === "/access/request") {
            if (context.role === "admin")
              throw new AccessError(409, "You already have admin access.");
            access.request(subject, form.get("reason"));
          } else {
            if (!context.canReview)
              throw new AccessError(
                403,
                "Only ASafariM administrators can review role requests.",
              );
            if (pathname === "/access/review")
              access.decide(
                subject,
                form.get("id"),
                form.get("decision"),
                form.get("reason"),
              );
            else if (pathname === "/access/retry") access.retry(form.get("id"));
            else throw new AccessError(404, "Page not found.");
          }
          res.writeHead(303, { location: "/access" });
          res.end();
          return;
        }
        if (pathname !== "/access" || req.method !== "GET")
          throw new AccessError(404, "Page not found.");
        return send(
          res,
          200,
          page(
            "Your Observatory access",
            accessPage(
              context,
              session.csrf,
              context.canReview ? access.list() : [],
            ),
          ),
        );
      }
      if (pathname === "/account")
        return send(
          res,
          200,
          page(
            "Your ASafariM session",
            `<p>You are signed in to Observatory.</p><a href="/">Back to dashboard</a> <a href="/access">Your role and requests</a><form action="/auth/logout" method="post"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><button>Sign out of Observatory</button></form><form action="/auth/logout/everywhere" method="post"><input type="hidden" name="csrf" value="${escape(session.csrf)}"><button>Sign out everywhere</button></form>`,
          ),
        );
      if (req.method === "POST") {
        if (!access || context.role !== "admin")
          throw new AccessError(
            403,
            "Observatory admin access is required for this action.",
          );
        auth.runtime.verifyCsrf(session, req.headers["x-csrf-token"]);
        if (pathname === "/api/refresh")
          return send(
            res,
            200,
            JSON.stringify({ refreshed: true }),
            "application/json",
          );
        if (pathname !== "/api/summary")
          throw new AccessError(404, "Action not found.");
      }
      const headers = { ...req.headers, host: target.host };
      for (const name of [
        "cookie",
        "authorization",
        "connection",
        "proxy-authorization",
        "transfer-encoding",
        "upgrade",
      ])
        delete headers[name];
      const proxy = http.request(
        {
          hostname: target.hostname,
          port: target.port,
          path: requestUrl.pathname + requestUrl.search,
          method: req.method,
          headers,
          timeout: 70000,
        },
        (response) => {
          const safe = { ...response.headers };
          delete safe["set-cookie"];
          delete safe.connection;
          res.writeHead(response.statusCode ?? 502, safe);
          response.pipe(res);
        },
      );
      proxy.on("timeout", () => proxy.destroy());
      proxy.on("error", () => {
        if (!res.headersSent)
          send(res, 502, "Private API unavailable.", "text/plain");
        else res.destroy();
      });
      req.on("aborted", () => proxy.destroy());
      res.on("close", () => {
        if (!res.writableEnded) proxy.destroy();
      });
      req.pipe(proxy);
    } catch (error) {
      if (!res.headersSent)
        send(
          res,
          error instanceof AccessError
            ? error.status
            : error?.status === 403
              ? 403
              : 503,
          page(
            "Action could not be completed",
            `<p>${escape(error instanceof AccessError ? error.message : "Your session or the identity service could not be verified. Try again.")}</p><a href="/access">Back to access settings</a>`,
          ),
        );
      else res.destroy();
    }
  });
}

export function authOptions(env, redis, store) {
  const origin = env.OBSERVATORY_ORIGIN;
  const issuer = env.OBSERVATORY_ISSUER;
  if (
    !origin ||
    new URL(origin).origin !== origin ||
    !origin.startsWith("https://")
  )
    throw new Error("Configure an exact HTTPS origin");
  if (issuer !== "https://id.asafarim.site")
    throw new Error("Invalid identity issuer");
  return {
    origin,
    issuer,
    scope: ["openid", "email", "profile", "roles", "offline_access"],
    intents: { signin: {}, register: { screen_hint: "register" } },
    clientId: env.OBSERVATORY_CLIENT_ID ?? "observatory",
    store,
    flows: store,
    idTokenSigningAlg: "ES256",
    postLogoutRedirectUri: origin + "/",
    bounds: {
      absoluteMs: 12 * 60 * 60 * 1000,
      idleMs: 30 * 60 * 1000,
      freshMs: 5 * 60 * 1000,
      revalidateMs: 60 * 1000,
    },
    hooks: { authorize: async (session) => session.identityKey.iss === issuer },
    requester: (request) => {
      const address = request.headers.get("x-observatory-client-ip") ?? "";
      return isIP(address) ? address : "unknown-proxy";
    },
    deps: {
      budget: async (name, key) => {
        const maximum =
          name === "start-global" ? 60 : name === "start" ? 20 : 100;
        const digest = createHmac("sha256", env.OBSERVATORY_SESSION_SECRET)
          .update(String(key))
          .digest("hex");
        const count = await redis.eval(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],600) end; return n",
          1,
          "observatory:budget:" + name + ":" + digest,
        );
        return Number(count) <= maximum;
      },
    },
  };
}

async function main() {
  if (
    !process.env.OBSERVATORY_REDIS_URL?.startsWith("redis://") ||
    !process.env.OBSERVATORY_SESSION_SECRET ||
    process.env.OBSERVATORY_SESSION_SECRET.length < 32
  )
    throw new Error("Configure Redis and a strong session secret");
  const redis = new Redis(process.env.OBSERVATORY_REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 5000,
  });
  await redis.connect();
  await redis.ping();
  const store = createRedisStore({
    redis,
    secret: process.env.OBSERVATORY_SESSION_SECRET,
    prefix: "observatory:auth",
  });
  const auth = createNodeAuth(authOptions(process.env, redis, store));
  const access = new AccessStore("/data/access/access.sqlite");
  const mailer = new SmtpClient({
    host: process.env.OBSERVATORY_SMTP_HOST,
    port: Number(process.env.OBSERVATORY_SMTP_PORT ?? 465),
    security: process.env.OBSERVATORY_SMTP_SECURITY ?? "tls",
    user: process.env.OBSERVATORY_SMTP_USER,
    password: process.env.OBSERVATORY_SMTP_PASSWORD,
    heloName: new URL(process.env.OBSERVATORY_ORIGIN).hostname,
    timeoutMs: 10000,
  });
  if (
    !process.env.OBSERVATORY_SMTP_HOST ||
    !process.env.OBSERVATORY_SMTP_FROM ||
    !["tls", "starttls"].includes(
      process.env.OBSERVATORY_SMTP_SECURITY ?? "tls",
    )
  )
    throw new Error("Configure secure notification delivery");
  let delivering = false;
  const deliver = async () => {
    if (delivering) return;
    delivering = true;
    try {
      await access.deliver((item) =>
        mailer.send({
          from: process.env.OBSERVATORY_SMTP_FROM,
          to: [item.recipient],
          subject: "Your Observatory admin access request was declined",
          text: `Your request for Observatory admin access was declined by an ASafariM administrator.\n\nReason: ${item.reason}\n\nYou still have viewer access. You can review your request at ${process.env.OBSERVATORY_ORIGIN}/access\n`,
        }),
      );
    } catch {
      console.error("Notification queue unavailable");
    } finally {
      delivering = false;
    }
  };
  const deliveryTimer = setInterval(() => void deliver(), 30000);
  deliveryTimer.unref();
  void deliver();
  const server = createGateway({
    auth,
    origin: process.env.OBSERVATORY_ORIGIN,
    access,
    vpsEnabled: process.env.OBSERVATORY_VPS_WORKSPACE === "true",
  });
  server.requestTimeout = 75000;
  server.headersTimeout = 10000;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const commands = [process.argv.slice(2)];
  if (process.env.OBSERVATORY_VPS_WORKSPACE === "true")
    commands.push([
      ...process.argv.slice(2),
      "-addr",
      "127.0.0.1:8086",
      "-root",
      "/var/repos",
      "-history",
      "/data/vps-history",
    ]);
  const children = commands.map((args) =>
    spawn(resolve(root, "bin/observatory-api"), args, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
    }),
  );
  for (const child of children) {
    child.on("error", () => {
      for (const running of children) running.kill("SIGTERM");
      console.error("Private API failed to start");
      process.exit(1);
    });
    child.on("exit", (code) => {
      server.close();
      redis.disconnect();
      for (const running of children)
        if (running !== child) running.kill("SIGTERM");
      process.exit(code ?? 1);
    });
  }
  server.listen(8080, "0.0.0.0", () =>
    console.log(
      "Observatory authenticated gateway 0.2.0 listening on port 8080",
    ),
  );
  const stop = () => {
    server.close();
    for (const child of children) child.kill("SIGTERM");
    setTimeout(() => process.exit(1), 6000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch(() => {
    console.error(
      "Authenticated gateway startup failed. Check runtime configuration and Redis.",
    );
    process.exit(1);
  });
