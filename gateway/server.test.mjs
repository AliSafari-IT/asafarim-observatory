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

async function withBackends(run) {
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
  try {
    await run(seen);
  } finally {
    for (const backend of backends)
      await new Promise((resolve) => backend.close(resolve));
  }
}

test("anonymous visitors read the local workspace but not the VPS workspace, actions or account pages", async () => {
  await withBackends(async (seen) => {
    // 401: no session. 403/503: a refused session or an identity outage never blocks public reads.
    for (const status of [401, 403, 503]) {
      seen.length = 0;
      const server = createGateway({
        auth: fake(status),
        origin,
        vpsEnabled: true,
        profile: async () => assert.fail("anonymous visitors are never profiled"),
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = "http://127.0.0.1:" + server.address().port;
      const headers = { host: "observatory.example.test", origin };
      try {
        for (const path of ["/api/snapshot", "/api/analysis", "/api/summary"]) {
          const r = await fetch(url + path, { headers });
          assert.equal(r.status, 200, path);
          assert.equal((await r.json()).workspace, "local");
        }
        assert.equal((await fetch(url + "/", { headers })).status, 200);
        assert.equal(
          (await fetch(url + "/?workspace=vps", { headers })).status,
          200,
          "the dashboard page itself is public; only its VPS data is gated",
        );
        assert.equal(
          (await fetch(url + "/api/snapshot", { method: "HEAD", headers }))
            .status,
          200,
        );
        const context = await fetch(url + "/auth/context", { headers });
        assert.equal(context.status, 200);
        const body = await context.json();
        assert.equal(body.authenticated, false);
        assert.equal(body.role, "anonymous");
        assert.equal(body.csrf, "");
        assert.deepEqual(
          body.workspaces.map((w) => w.id),
          ["local"],
        );
        const expected = status === 401 ? 401 : status;
        for (const path of [
          "/api/snapshot?workspace=vps",
          "/api/snapshot?workspace=local&workspace=vps",
        ]) {
          const r = await fetch(url + path, { headers });
          assert.equal(r.status, expected, path);
          if (status === 401)
            assert.equal((await r.json()).error.code, "sign_in_required");
        }
        for (const path of ["/api/summary", "/api/refresh"])
          assert.equal(
            (await fetch(url + path, { method: "POST", headers })).status,
            expected,
          );
        for (const path of ["/account", "/access"]) {
          const r = await fetch(url + path, { headers });
          assert.equal(r.status, status === 401 ? 303 : status, path);
          if (status === 401) assert.equal(r.headers.get("location"), "/login");
        }
        assert.deepEqual(
          seen.map((item) => item.id),
          ["local", "local", "local", "local", "local", "local"],
        );
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    }
  });
  const { server, url } = await start(fake());
  try {
    const login = await fetch(url + "/login", {
      headers: { host: "observatory.example.test" },
    });
    assert.equal(login.status, 200);
    const html = await login.text();
    assert.match(html, /Sign in with ASafariM/);
    assert.match(html, /laptop workspace is public/);
    assert.equal((await fetch(url + "/healthz")).status, 200);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("the VPS workspace needs an account the identity service still confirms as active", async () => {
  await withBackends(async (seen) => {
    const { AccessStore } = await import("./access.mjs");
    const access = new AccessStore(":memory:");
    let identity = "active";
    const server = createGateway({
      auth: {
        ...fake(),
        require: async () => ({
          view: { identityKey: { sub: "member" } },
          csrf: "csrf",
        }),
      },
      origin,
      access,
      vpsEnabled: true,
      profile: async () => {
        if (identity === "active")
          return { email: "member@example.test", reviewer: false };
        const { AccessError } = await import("./access.mjs");
        throw new AccessError(
          identity === "inactive" ? 401 : 503,
          "Your ASafariM account could not be verified.",
        );
      },
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = "http://127.0.0.1:" + server.address().port;
    const headers = { host: "observatory.example.test", origin };
    try {
      let context = await (await fetch(url + "/auth/context", { headers })).json();
      assert.equal(context.active, true);
      assert.deepEqual(
        context.workspaces.map((w) => w.id),
        ["local", "vps"],
      );
      assert.equal(
        (await (await fetch(url + "/api/snapshot?workspace=vps", { headers })).json())
          .workspace,
        "vps",
      );
      // Deactivated in the ASafariM admin panel: the identity service refuses /me.
      identity = "inactive";
      const refused = await fetch(url + "/api/snapshot?workspace=vps", { headers });
      assert.equal(refused.status, 403);
      assert.equal((await refused.json()).error.code, "active_account_required");
      context = await (await fetch(url + "/auth/context", { headers })).json();
      assert.equal(context.authenticated, true);
      assert.equal(context.active, false);
      assert.equal(context.role, "viewer");
      assert.deepEqual(
        context.workspaces.map((w) => w.id),
        ["local"],
      );
      assert.equal((await fetch(url + "/api/snapshot", { headers })).status, 200);
      identity = "unavailable";
      assert.equal(
        (await fetch(url + "/api/snapshot?workspace=vps", { headers })).status,
        503,
      );
      assert.equal((await fetch(url + "/api/snapshot", { headers })).status, 200);
      assert.deepEqual(
        seen.map((item) => item.id),
        ["vps", "local", "local"],
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
      access.close();
    }
  });
});

test("foreign hosts, cross-origin actions, denied users and outages fail closed", async () => {
  for (const status of [403, 503]) {
    const { server, url } = await start(fake(status));
    try {
      assert.equal(
        (
          await fetch(url + "/account", {
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

test("theme assets are served by the gateway; private pages still require sign-in", async () => {
  const { server, url } = await start(fake());
  try {
    const headers = { host: "observatory.example.test" };
    for (const name of ["theme.js", "theme.css"]) {
      const response = await fetch(url + "/asafarim-theme/" + name, {
        headers,
      });
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get("content-type"),
        name.endsWith(".js") ? /javascript/ : /text\/css/,
      );
    }
    assert.equal((await fetch(url + "/access", { headers })).status, 303);
    const login = await (await fetch(url + "/login", { headers })).text();
    assert.match(login, /aria-label="Observatory navigation"/);
    assert.match(login, /data-theme-toggle/);
    assert.match(login, /Footer navigation/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
