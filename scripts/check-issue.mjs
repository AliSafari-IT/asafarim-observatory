export function issueReferences(body, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository))
    throw new Error("Invalid repository");
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\b(?:closes?|closed|fix(?:es|ed)?|resolves?|resolved)\\s+(?:#|https://github\\.com/${escaped}/issues/)([1-9][0-9]*)(?=\\s|[.,;)]|$)`,
    "gi",
  );
  return [
    ...new Set(
      [...String(body ?? "").matchAll(pattern)]
        .map((match) => Number(match[1]))
        .filter(Number.isSafeInteger),
    ),
  ];
}
export async function validateIssue({
  body,
  repository,
  createdAt,
  token,
  fetcher = fetch,
}) {
  const refs = issueReferences(body, repository);
  if (!refs.length)
    throw new Error(
      "Add Closes #<issue> for an originating issue in this repository.",
    );
  if (!Number.isFinite(Date.parse(createdAt)))
    throw new Error("Missing PR creation timestamp.");
  for (const number of refs) {
    const response = await fetcher(
      `https://api.github.com/repos/${repository}/issues/${number}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
        signal: AbortSignal.timeout(10000),
      },
    );
    if (!response.ok)
      throw new Error(
        `Cannot verify originating issue #${number} (HTTP ${response.status}).`,
      );
    const issue = await response.json();
    if (
      issue.pull_request ||
      issue.state !== "open" ||
      !Number.isFinite(Date.parse(issue.created_at)) ||
      Date.parse(issue.created_at) > Date.parse(createdAt)
    )
      throw new Error(
        `Issue #${number} must be an open issue created before this PR, not another PR.`,
      );
  }
  return refs;
}
if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  validateIssue({
    body: process.env.PR_BODY,
    repository: process.env.GITHUB_REPOSITORY,
    createdAt: process.env.PR_CREATED_AT,
    token: process.env.GITHUB_TOKEN,
  })
    .then((refs) =>
      console.log(
        `Verified originating issue(s): ${refs.map((n) => "#" + n).join(", ")}`,
      ),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
