import test from "node:test";
import assert from "node:assert/strict";
import { issueReferences, validateIssue } from "./check-issue.mjs";
const repository = "example/observatory";
const options = {
  repository,
  body: "Closes #11",
  createdAt: "2026-11-08T15:40:00Z",
  token: "fixture",
};
const valid = { state: "open", created_at: "2026-11-08T15:00:00Z" };
const fetcher = (value) => async () => new Response(JSON.stringify(value));
test("recognizes same-repository closing references and rejects unrelated or malformed references", () => {
  assert.deepEqual(
    issueReferences(
      "Closes #11\nFixes https://github.com/example/observatory/issues/12.",
      repository,
    ),
    [11, 12],
  );
  for (const body of [
    "Related #11",
    "Closes #<issue>",
    "Closes #0",
    "Closes #12abc",
    "Closes https://github.com/other/repo/issues/11",
  ])
    assert.deepEqual(issueReferences(body, repository), []);
});
test("requires a real open issue that predates the PR and fails on API errors", async () => {
  assert.deepEqual(
    await validateIssue({ ...options, fetcher: fetcher(valid) }),
    [11],
  );
  for (const issue of [
    { ...valid, pull_request: {} },
    { ...valid, state: "closed" },
    { ...valid, created_at: "2026-11-09T00:00:00Z" },
    {},
  ])
    await assert.rejects(
      validateIssue({ ...options, fetcher: fetcher(issue) }),
    );
  await assert.rejects(
    validateIssue({ ...options, body: "No issue", fetcher: fetcher(valid) }),
  );
  await assert.rejects(
    validateIssue({
      ...options,
      fetcher: async () => new Response("", { status: 404 }),
    }),
  );
});
