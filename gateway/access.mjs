import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export class AccessError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const text = (value, min, max) =>
  typeof value === "string" &&
  value.trim().length >= min &&
  value.trim().length <= max &&
  !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
export class AccessStore {
  constructor(path) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS profiles (subject TEXT PRIMARY KEY, email TEXT, role TEXT NOT NULL DEFAULT 'viewer' CHECK(role IN ('viewer','admin')), onboarded INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, subject TEXT NOT NULL REFERENCES profiles(subject), reason TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('pending','approved','declined','revoked')), decision_reason TEXT, reviewer TEXT, created_at INTEGER NOT NULL, decided_at INTEGER);
      CREATE UNIQUE INDEX IF NOT EXISTS one_pending ON requests(subject) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS notifications (id TEXT PRIMARY KEY REFERENCES requests(id), recipient TEXT NOT NULL, reason TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, sent_at INTEGER);
      CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY, actor TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, at INTEGER NOT NULL);`);
  }
  profile(sub, email) {
    this.db
      .prepare(
        "INSERT INTO profiles(subject,email,created_at) VALUES(?,?,?) ON CONFLICT(subject) DO UPDATE SET email=excluded.email",
      )
      .run(sub, email, Date.now());
    return this.db
      .prepare("SELECT role,onboarded FROM profiles WHERE subject=?")
      .get(sub);
  }
  context(sub, reviewer) {
    const p = this.db
      .prepare("SELECT role,onboarded FROM profiles WHERE subject=?")
      .get(sub);
    return {
      role: reviewer ? "admin" : (p?.role ?? "viewer"),
      canReview: reviewer,
      onboarded: !!p?.onboarded,
      request:
        this.db
          .prepare(
            "SELECT id,reason,status,decision_reason,created_at,decided_at FROM requests WHERE subject=? ORDER BY created_at DESC LIMIT 1",
          )
          .get(sub) ?? null,
    };
  }
  onboard(sub) {
    this.db.prepare("UPDATE profiles SET onboarded=1 WHERE subject=?").run(sub);
  }
  request(sub, reason) {
    if (!text(reason, 10, 2000))
      throw new AccessError(
        400,
        "Explain why you need admin access (10–2000 characters).",
      );
    const p = this.db
      .prepare("SELECT email,role FROM profiles WHERE subject=?")
      .get(sub);
    if (!p?.email)
      throw new AccessError(
        400,
        "Add and verify an email address in your ASafariM account before requesting admin access.",
      );
    if (p.role === "admin")
      throw new AccessError(409, "You already have admin access.");
    const latest = this.db
      .prepare(
        "SELECT status,created_at FROM requests WHERE subject=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(sub);
    if (latest?.status === "pending")
      throw new AccessError(409, "Your request is already awaiting review.");
    if (latest && Date.now() - latest.created_at < 86400000)
      throw new AccessError(
        429,
        "Wait 24 hours before submitting another request.",
      );
    this.db
      .prepare(
        "INSERT INTO requests(id,subject,reason,status,created_at) VALUES(?,?,?,'pending',?)",
      )
      .run(randomUUID(), sub, reason.trim(), Date.now());
    this.onboard(sub);
  }
  list() {
    return this.db
      .prepare(
        "SELECT r.*,p.email,n.state AS email_state,n.attempts AS email_attempts FROM requests r JOIN profiles p ON p.subject=r.subject LEFT JOIN notifications n ON n.id=r.id ORDER BY r.created_at DESC LIMIT 200",
      )
      .all();
  }
  decide(actor, id, decision, reason) {
    if (!["approved", "declined", "revoked"].includes(decision))
      throw new AccessError(400, "Choose a valid decision.");
    const note =
      typeof reason === "string" ? reason.trim() : reason == null ? "" : null;
    if (
      note === null ||
      (decision === "declined"
        ? !text(note, 10, 2000)
        : note !== "" && !text(note, 1, 2000))
    )
      throw new AccessError(
        400,
        decision === "declined"
          ? "Give a rejection reason (10–2000 characters)."
          : "An optional note must be at most 2000 characters.",
      );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const r = this.db
        .prepare(
          "SELECT r.*,p.email FROM requests r JOIN profiles p ON p.subject=r.subject WHERE r.id=?",
        )
        .get(id);
      if (
        !r ||
        (decision === "revoked"
          ? r.status !== "approved"
          : r.status !== "pending")
      )
        throw new AccessError(
          409,
          "This request has already changed. Reload before reviewing it.",
        );
      if (r.subject === actor)
        throw new AccessError(403, "You cannot review your own request.");
      const now = Date.now();
      this.db
        .prepare(
          "UPDATE requests SET status=?,decision_reason=?,reviewer=?,decided_at=? WHERE id=?",
        )
        .run(decision, note || null, actor, now, id);
      this.db
        .prepare("UPDATE profiles SET role=? WHERE subject=?")
        .run(decision === "approved" ? "admin" : "viewer", r.subject);
      this.db
        .prepare("INSERT INTO audit(actor,action,target,at) VALUES(?,?,?,?)")
        .run(actor, decision, id, now);
      if (decision === "declined") {
        if (!r.email)
          throw new AccessError(
            409,
            "The account needs a verified email address before a rejection can be delivered.",
          );
        this.db
          .prepare(
            "INSERT INTO notifications(id,recipient,reason,next_at) VALUES(?,?,?,?)",
          )
          .run(id, r.email, note, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  async deliver(send) {
    const items = this.db
      .prepare(
        "SELECT * FROM notifications WHERE state='pending' AND next_at<=? LIMIT 10",
      )
      .all(Date.now());
    for (const item of items) {
      try {
        await send(item);
        this.db
          .prepare(
            "UPDATE notifications SET state='sent',sent_at=?,attempts=attempts+1 WHERE id=?",
          )
          .run(Date.now(), item.id);
      } catch {
        const attempts = item.attempts + 1;
        this.db
          .prepare(
            "UPDATE notifications SET attempts=?,state=?,next_at=? WHERE id=?",
          )
          .run(
            attempts,
            attempts >= 8 ? "failed" : "pending",
            Date.now() + Math.min(3600000, 60000 * 2 ** attempts),
            item.id,
          );
      }
    }
  }
  retry(id) {
    this.db
      .prepare(
        "UPDATE notifications SET state='pending',attempts=0,next_at=? WHERE id=? AND state='failed'",
      )
      .run(Date.now(), id);
  }
  close() {
    this.db.close();
  }
}

export async function identityProfile(session, fetcher = fetch) {
  const response = await fetcher("https://id.asafarim.site/me", {
    headers: {
      authorization: `Bearer ${session.accessToken()}`,
      accept: "application/json",
    },
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok)
    throw new AccessError(
      response.status === 401 ? 401 : 503,
      "Your ASafariM account could not be verified.",
    );
  const raw = await response.text();
  if (raw.length > 16384)
    throw new AccessError(503, "Identity response exceeded its limit.");
  const info = JSON.parse(raw);
  if (info.sub !== session.view.identityKey.sub)
    throw new AccessError(403, "Identity account mismatch.");
  const email =
    info.email_verified === true &&
    typeof info.email === "string" &&
    /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(info.email) &&
    info.email.length <= 254
      ? info.email
      : null;
  const reviewer =
    Array.isArray(info.roles) &&
    info.roles.some((role) =>
      ["identity.admin", "admin", "superadmin"].includes(role),
    );
  return { email, reviewer };
}
