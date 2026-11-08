import test from "node:test";
import assert from "node:assert/strict";
import { createGateway, authOptions } from "./server.mjs";

import http from "node:http";
const fetch = (url, options = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method: options.method ?? "GET", headers: options.headers },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          resolve({
            status: res.statusCode,
            headers: new Headers(res.headers),
            text: async () => body,
            json: async () => JSON.parse(body),
          });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });

const origin = "https://observatory.example.test";
async function start(auth) {
  const server = createGateway({ auth, origin });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: "http://127.0.0.1:" + server.address().port };
}
const fake = (status = 401) => ({
  handle: async () => false,
  startUrl: () => "/auth/start?return=%2F",
  require: async () => {
    throw Object.assign(new Error("fixture"), { status });
  },
});

test("anonymous users cannot read API or static workspace content", async () => {
  const { server, url } = await start(fake());
  try {
    for (const path of ["/api/snapshot", "/api/analysis", "/api/summary"]) {
      const r = await fetch(url + path, {
        headers: { host: "observatory.example.test" },
        redirect: "manual",
      });
      assert.equal(r.status, 401);
      assert.equal((await r.json()).error.code, "sign_in_required");
    }
    const root = await fetch(url + "/", {
      headers: { host: "observatory.example.test" },
      redirect: "manual",
    });
    assert.equal(root.status, 303);
    assert.equal(root.headers.get("location"), "/login");
    const login = await fetch(url + "/login", {
      headers: { host: "observatory.example.test" },
    });
    assert.equal(login.status, 200);
    assert.match(await login.text(), /Sign in with ASafariM/);
    assert.equal((await fetch(url + "/healthz")).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("foreign hosts, cross-origin actions, denied users and outages fail closed", async () => {
  for (const status of [403, 503]) {
    const { server, url } = await start(fake(status));
    try {
      assert.equal(
        (
          await fetch(url + "/api/snapshot", {
            headers: { host: "observatory.example.test" },
          })
        ).status,
        status,
      );
      assert.equal(
        (
          await fetch(url + "/api/summary", {
            method: "POST",
            headers: {
              host: "observatory.example.test",
              origin: "https://attacker.test",
            },
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await fetch(url + "/", {
            headers: { host: "attacker.test" },
            redirect: "manual",
          })
        ).status,
        400,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }
});

test("account pages escape CSRF values and auth accepts registered accounts from the configured issuer", async () => {
  const auth = { ...fake(), require: async () => ({ csrf: '<fixture>"' }) };
  const { server, url } = await start(auth);
  try {
    const r = await fetch(url + "/account", {
      headers: { host: "observatory.example.test" },
    });
    const html = await r.text();
    assert.equal(r.status, 200);
    assert.match(html, /&lt;fixture&gt;&quot;/);
    assert.doesNotMatch(html, /<fixture>/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const env = {
    OBSERVATORY_ORIGIN: origin,
    OBSERVATORY_ISSUER: "https://id.asafarim.site",
    OBSERVATORY_SESSION_SECRET: "a".repeat(64),
  };
  const options = authOptions(env, {}, {});
  const { createNodeAuth } = await import("@asafarim/auth-runtime/node");
  assert.doesNotThrow(() => createNodeAuth(options));
  assert.equal(
    await options.hooks.authorize({
      identityKey: { iss: env.OBSERVATORY_ISSUER, sub: "any-registered-user" },
    }),
    true,
  );
  assert.equal(
    await options.hooks.authorize({
      identityKey: { iss: "https://other.test", sub: "any" },
    }),
    false,
  );
});

test("viewer cannot invoke paid actions or review requests; admin needs CSRF and reviewer role", async () => {
  const { AccessStore } = await import("./access.mjs");
  const access = new AccessStore(":memory:");
  let user = "viewer",
    reviewer = false;
  const auth = {
    ...fake(),
    runtime: {
      verifyCsrf: (_s, value) => {
        if (value !== "fixture-csrf")
          throw Object.assign(new Error("csrf"), { status: 403 });
      },
    },
    require: async () => ({
      view: { identityKey: { sub: user } },
      csrf: "fixture-csrf",
    }),
  };
  const server = createGateway({
    auth,
    origin,
    access,
    profile: async () => ({ email: `${user}@example.test`, reviewer }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + server.address().port;
  const headers = {
    host: "observatory.example.test",
    origin,
    "x-csrf-token": "fixture-csrf",
  };
  try {
    const c = await fetch(url + "/auth/context", { headers });
    assert.equal((await c.json()).role, "viewer");
    for (const path of ["/api/summary", "/api/refresh"])
      assert.equal(
        (await fetch(url + path, { method: "POST", headers })).status,
        403,
      );
    assert.equal((await fetch(url + "/access", { headers })).status, 200);
    access.request(user, "I maintain the workspace collector and need admin.");
    const id = access.list()[0].id;
    access.decide(
      "asafarim-admin",
      id,
      "approved",
      "Approved for workspace maintenance.",
    );
    assert.equal(
      (
        await fetch(url + "/api/refresh", {
          method: "POST",
          headers: { ...headers, "x-csrf-token": "wrong" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(url + "/api/refresh", { method: "POST", headers })).status,
      200,
    );
    assert.equal((await fetch(url + "/auth/context", { headers })).status, 200);
    assert.equal(
      (await (await fetch(url + "/auth/context", { headers })).json())
        .canReview,
      false,
    );
    access.decide(
      "asafarim-admin",
      id,
      "revoked",
      "Workspace maintenance has ended.",
    );
    assert.equal(
      (await fetch(url + "/api/refresh", { method: "POST", headers })).status,
      403,
    );
    reviewer = true;
    assert.equal(
      (await fetch(url + "/api/refresh", { method: "POST", headers })).status,
      200,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    access.close();
  }
});

test("workspace IDs route to isolated private APIs; paths and disabled workspaces are refused", async () => {
  const { AccessStore } = await import("./access.mjs");
  const access = new AccessStore(":memory:");
  const seen = [];
  const backends = [];
  for (const [port, id] of [
    [8085, "local"],
    [8086, "vps"],
  ]) {
    const backend = http.createServer((req, res) => {
      seen.push({ id, url: req.url, method: req.method });
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ workspace: id }));
    });
    await new Promise((resolve) => backend.listen(port, "127.0.0.1", resolve));
    backends.push(backend);
  }
  const auth = {
    ...fake(),
    require: async () => ({
      view: { identityKey: { sub: "fixture" } },
      csrf: "csrf",
    }),
    runtime: { verifyCsrf: (_session, token) => assert.equal(token, "csrf") },
  };
  const profile = async () => ({
    email: "fixture@example.test",
    reviewer: true,
  });
  const gateway = createGateway({
    auth,
    origin,
    access,
    profile,
    vpsEnabled: true,
  });
  await new Promise((resolve) => gateway.listen(0, "127.0.0.1", resolve));
  const url = "http://127.0.0.1:" + gateway.address().port;
  const headers = {
    host: "observatory.example.test",
    origin,
    "x-csrf-token": "csrf",
  };
  try {
    assert.equal(
      (await (await fetch(url + "/api/snapshot", { headers })).json())
        .workspace,
      "local",
    );
    assert.equal(
      (
        await (
          await fetch(url + "/api/snapshot?workspace=vps", { headers })
        ).json()
      ).workspace,
      "vps",
    );
    assert.equal(
      (
        await (
          await fetch(url + "/api/summary?workspace=vps", {
            method: "POST",
            headers,
          })
        ).json()
      ).workspace,
      "vps",
    );
    assert.equal(
      (await fetch(url + "/api/snapshot?workspace=/etc", { headers })).status,
      400,
    );
    assert.equal(
      (
        await fetch(url + "/api/snapshot?workspace=vps&workspace=local", {
          headers,
        })
      ).status,
      400,
    );
    assert.deepEqual(seen, [
      { id: "local", url: "/api/snapshot", method: "GET" },
      { id: "vps", url: "/api/snapshot", method: "GET" },
      { id: "vps", url: "/api/summary", method: "POST" },
    ]);
    const context = await (
      await fetch(url + "/auth/context", { headers })
    ).json();
    assert.deepEqual(
      context.workspaces.map((w) => w.id),
      ["local", "vps"],
    );
  } finally {
    await new Promise((resolve) => gateway.close(resolve));
    for (const backend of backends)
      await new Promise((resolve) => backend.close(resolve));
    access.close();
  }
  const disabled = await start({
    ...fake(),
    require: async () => ({ csrf: "csrf" }),
  });
  try {
    assert.equal(
      (await fetch(disabled.url + "/api/snapshot?workspace=vps", { headers }))
        .status,
      400,
    );
  } finally {
    await new Promise((resolve) => disabled.server.close(resolve));
  }
});
