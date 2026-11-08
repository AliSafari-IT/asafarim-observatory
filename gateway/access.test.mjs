import test from "node:test";
import assert from "node:assert/strict";
import { AccessStore, identityProfile } from "./access.mjs";

test("viewer default, duplicate requests, approval, revocation and decision races", () => {
  const store = new AccessStore(":memory:");
  try {
    store.profile("viewer", "viewer@example.test");
    assert.equal(store.context("viewer", false).role, "viewer");
    assert.equal(store.context("global", true).canReview, true);
    store.request(
      "viewer",
      "I maintain the collector and need to generate summaries.",
    );
    assert.throws(
      () => store.request("viewer", "Another request because I need admin."),
      { status: 409 },
    );
    const id = store.list()[0].id;
    assert.throws(
      () => store.decide("viewer", id, "approved", "I approve my own request."),
      { status: 403 },
    );
    store.decide(
      "global",
      id,
      "approved",
      "Approved for collector maintenance.",
    );
    assert.equal(store.context("viewer", false).role, "admin");
    assert.equal(store.context("viewer", false).canReview, false);
    assert.throws(
      () =>
        store.decide(
          "other-global",
          id,
          "declined",
          "Another decision for this request.",
        ),
      { status: 409 },
    );
    store.decide(
      "global",
      id,
      "revoked",
      "Maintenance responsibilities have ended.",
    );
    assert.equal(store.context("viewer", false).role, "viewer");
  } finally {
    store.close();
  }
});

test("decline queues reason email, retries failures and retains viewer access", async () => {
  const store = new AccessStore(":memory:");
  try {
    store.profile("user", "user@example.test");
    store.request(
      "user",
      "I would like to generate shared workspace summaries.",
    );
    const id = store.list()[0].id;
    store.decide(
      "admin",
      id,
      "declined",
      "Admin tools are limited to workspace maintainers.",
    );
    assert.equal(store.context("user", false).role, "viewer");
    await store.deliver(async () => {
      throw new Error("SMTP unavailable");
    });
    assert.equal(store.list()[0].email_state, "pending");
    assert.equal(store.list()[0].email_attempts, 1);
    store.db.prepare("UPDATE notifications SET next_at=0").run();
    let mail;
    await store.deliver(async (item) => {
      mail = item;
    });
    assert.match(mail.reason, /workspace maintainers/);
    assert.equal(mail.recipient, "user@example.test");
    assert.equal(store.list()[0].email_state, "sent");
    await store.deliver(async () => assert.fail("already sent"));
    assert.throws(
      () => store.request("user", "Requesting admin again immediately."),
      { status: 429 },
    );
  } finally {
    store.close();
  }
});

test("verified provider profile required; forged subjects and unverified email rejected", async () => {
  const session = {
    view: { identityKey: { sub: "account" } },
    accessToken: () => "server-only-fixture",
  };
  const response = (data) => async () => new Response(JSON.stringify(data));
  assert.deepEqual(
    await identityProfile(
      session,
      response({
        sub: "account",
        roles: ["identity.admin"],
        email: "admin@example.test",
        email_verified: true,
      }),
    ),
    { reviewer: true, email: "admin@example.test" },
  );
  assert.deepEqual(
    await identityProfile(
      session,
      response({
        sub: "account",
        roles: ["viewer"],
        email: "unverified@example.test",
        email_verified: false,
      }),
    ),
    { reviewer: false, email: null },
  );
  await assert.rejects(
    identityProfile(
      session,
      response({ sub: "other", roles: ["identity.admin"] }),
    ),
    { status: 403 },
  );
  const store = new AccessStore(":memory:");
  try {
    store.profile("phone-user", null);
    assert.throws(
      () =>
        store.request(
          "phone-user",
          "Please grant me app administrator access.",
        ),
      { status: 400 },
    );
  } finally {
    store.close();
  }
});
