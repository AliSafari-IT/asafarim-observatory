import { AccessError } from "./access.mjs";
export const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const field = (csrf) =>
  `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
export function accessPage(context, csrf, requests = []) {
  const request = context.request;
  return `<p>Your role: <strong>${escape(context.role)}</strong>. Viewers can browse saved observations and summaries. Admins can refresh the view and generate AI summaries.</p><a href="/">Back to dashboard</a>
 ${!context.onboarded ? `<h2>Welcome to Observatory</h2><p>Viewer access is already yours. Continue as a viewer, or tell us why you need admin tools. Requests are reviewed by an ASafariM administrator.</p><form method="post" action="/access/continue">${field(csrf)}<button>Continue as viewer</button></form>` : ""}
 ${request ? `<h2>Your latest request: ${escape(request.status)}</h2><p>${escape(request.reason)}</p>${request.decision_reason ? `<p>Reviewer’s reason: ${escape(request.decision_reason)}</p>` : ""}` : ""}
 ${context.role === "viewer" && request?.status !== "pending" ? `<h2>Request admin access</h2><p>A verified ASafariM account email is required. We store your request and review decision. If declined, we email the reviewer’s reason. Do not include secrets or sensitive information.</p><form method="post" action="/access/request">${field(csrf)}<label>Why do you need admin access?<textarea name="reason" required minlength="10" maxlength="2000" rows="5"></textarea></label><button>Submit admin request</button></form>` : ""}
 ${context.canReview ? `<h2>Review admin requests</h2><p>Only ASafariM administrators can approve, decline or revoke these grants. Observatory admins cannot approve requests. New grants apply on the next action.</p>${requests.length ? "" : "<p>No requests yet.</p>"}${requests.map((r) => `<article><h3>${escape(r.email ?? "Account without verified email")}</h3><p>${escape(r.status)} · ${escape(new Date(r.created_at).toISOString())}</p><p>${escape(r.reason)}</p>${r.decision_reason ? `<p>Decision: ${escape(r.decision_reason)}</p>` : ""}${r.status === "pending" || r.status === "approved" ? `<form method="post" action="/access/review">${field(csrf)}<input type="hidden" name="id" value="${escape(r.id)}"><label>Reason for your decision<textarea name="reason" required minlength="10" maxlength="2000" rows="3"></textarea></label>${r.status === "pending" ? '<button name="decision" value="approved">Approve admin</button> <button name="decision" value="declined">Decline and email reason</button>' : '<button name="decision" value="revoked">Revoke admin</button>'}</form>` : ""}${r.email_state ? `<p>Rejection email: ${escape(r.email_state)}${r.email_state === "failed" ? `<form method="post" action="/access/retry">${field(csrf)}<input type="hidden" name="id" value="${escape(r.id)}"><button>Retry email delivery</button></form>` : ""}</p>` : ""}</article>`).join("")}` : ""}`;
}
export async function formBody(req) {
  if (
    !req.headers["content-type"]?.startsWith(
      "application/x-www-form-urlencoded",
    )
  )
    throw new AccessError(415, "Use the account form.");
  const parts = [];
  let size = 0;
  for await (const part of req) {
    size += part.length;
    if (size > 12000) throw new AccessError(413, "The form is too large.");
    parts.push(part);
  }
  return new URLSearchParams(Buffer.concat(parts).toString("utf8"));
}
