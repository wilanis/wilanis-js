// The GitHub reads and writes the board sync makes, over GraphQL with the token in GH_TOKEN. The token needs
// the organization project's read and write and the repository's issues; GITHUB_TOKEN has no project scope.

export const OWNER = 'wilanis';
export const REPO = 'wilanis-js';
export const PROJECT = 1;

/** The answer to one GraphQL request, or a thrown error naming what GitHub refused. */
export async function graphql(query, variables = {}) {
  const token = process.env.GH_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set: the board sync needs a token with project and issues write');
  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { authorization: `bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  const answer = await response.json();
  if (!response.ok) throw new Error(`GitHub answered ${response.status}: ${answer.message ?? JSON.stringify(answer)}`);
  if (answer.errors?.length) {
    // The path names the field refused, so a token missing one permission says which.
    const said = answer.errors.map((e) => (e.path ? `${e.path.join('.')}: ${e.message}` : e.message));
    throw new Error(said.join('; '));
  }
  return answer.data;
}

/** The answer to one REST request against the repository, e.g. `rest('POST', 'issues', {...})`. */
export async function rest(method, path, body) {
  const response = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/${path}`, {
    method,
    headers: { authorization: `bearer ${process.env.GH_TOKEN}`, accept: 'application/vnd.github+json' },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);
  return response.json();
}

const ISSUE = `
  id number state title body updatedAt
  labels(first: 30) { nodes { name } }
  assignees(first: 5) { nodes { login } }
  issueType { name }
  milestone { title }
  parent { number labels(first: 20) { nodes { name } } }
  blockedBy(first: 30) { nodes { number state } }
  blocking(first: 30) { nodes { number state } }
  subIssues(first: 50) { nodes { number state } }
  subIssuesSummary { completed total }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: true) { nodes { number state isDraft } }
  projectItems(first: 10) { nodes { id project { number owner { ... on Organization { login } } }
    fieldValues(first: 30) { nodes {
      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
      ... on ProjectV2ItemFieldMultiSelectValue { options { name } field { ... on ProjectV2FieldCommon { name } } }
    } } } }`;

/** One issue in the shape `derive.mjs` reads, with the ids and board values the writes need. */
function shape(node) {
  const item = node.projectItems.nodes.find((i) => i.project.number === PROJECT && i.project.owner?.login === OWNER);
  const board = {};
  for (const value of item?.fieldValues.nodes ?? []) {
    if (!value.field) continue;
    board[value.field.name] = value.options ? value.options.map((o) => o.name) : value.name;
  }
  return {
    id: node.id,
    number: node.number,
    state: node.state,
    title: node.title,
    body: node.body,
    updatedAt: node.updatedAt,
    labels: node.labels.nodes.map((l) => l.name),
    assignees: node.assignees.nodes.map((a) => a.login),
    issueType: node.issueType?.name ?? null,
    milestone: node.milestone?.title ?? null,
    parent: node.parent && { number: node.parent.number, labels: node.parent.labels.nodes.map((l) => l.name) },
    blockers: node.blockedBy.nodes.map((b) => b.number),
    openBlockers: node.blockedBy.nodes.filter((b) => b.state === 'OPEN').map((b) => b.number),
    blocking: node.blocking.nodes.filter((b) => b.state === 'OPEN').map((b) => b.number),
    steps: node.subIssues.nodes.filter((s) => s.state === 'OPEN').map((s) => s.number),
    stepsDone: node.subIssuesSummary.completed,
    pullRequests: node.closedByPullRequestsReferences.nodes,
    item: item?.id ?? null,
    board,
  };
}

/** The issue numbered `number`, or null when the number is a pull request or nothing. */
export async function issue(number) {
  const data = await graphql(`query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ issue(number:$n){ ${ISSUE} } } }`, {
    o: OWNER,
    r: REPO,
    n: number,
  });
  return data.repository.issue ? shape(data.repository.issue) : null;
}

/** Every issue matching a search, e.g. `is:open` or `is:closed closed:>2026-09-01`. */
export async function issues(search) {
  const found = [];
  let after = null;
  do {
    const data = await graphql(
      `query($q:String!,$a:String){ search(type: ISSUE, query: $q, first: 50, after: $a){
        pageInfo { hasNextPage endCursor } nodes { ... on Issue { ${ISSUE} } } } }`,
      { q: `repo:${OWNER}/${REPO} is:issue ${search}`, a: after },
    );
    found.push(...data.search.nodes.map(shape));
    after = data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null;
  } while (after);
  return found;
}

/** The issues a pull request serves: those it closes, and the one its branch name claims. */
export async function servedBy(number) {
  const data = await graphql(
    `query($o:String!,$r:String!,$n:Int!){ repository(owner:$o,name:$r){ pullRequest(number:$n){
      headRefName closingIssuesReferences(first: 20) { nodes { number } } } } }`,
    { o: OWNER, r: REPO, n: number },
  );
  const pr = data.repository.pullRequest;
  return { branch: pr.headRefName, closes: pr.closingIssuesReferences.nodes.map((i) => i.number) };
}

/** The names of every branch on the remote. */
export async function branches() {
  const names = [];
  let after = null;
  do {
    const data = await graphql(
      `query($o:String!,$r:String!,$a:String){ repository(owner:$o,name:$r){
        refs(refPrefix: "refs/heads/", first: 100, after: $a){ pageInfo { hasNextPage endCursor } nodes { name } } } }`,
      { o: OWNER, r: REPO, a: after },
    );
    names.push(...data.repository.refs.nodes.map((n) => n.name));
    after = data.repository.refs.pageInfo.hasNextPage ? data.repository.refs.pageInfo.endCursor : null;
  } while (after);
  return names;
}

/** The project's id, its fields' ids and options' ids by name, and the organization's issue types by name. */
export async function project() {
  const data = await graphql(
    `query($o:String!,$p:Int!){ organization(login:$o){
      issueTypes(first: 30) { nodes { id name } }
      projectV2(number:$p){ id fields(first: 50) { nodes {
        ... on ProjectV2FieldCommon { id name }
        ... on ProjectV2SingleSelectField { options { id name } }
        ... on ProjectV2MultiSelectField { multiSelectOptions { id name } } } } } } }`,
    { o: OWNER, p: PROJECT },
  );
  const org = data.organization;
  const fields = {};
  for (const f of org.projectV2.fields.nodes) {
    const options = f.options ?? f.multiSelectOptions;
    fields[f.name] = { id: f.id, options: Object.fromEntries((options ?? []).map((o) => [o.name, o.id])) };
  }
  return { id: org.projectV2.id, fields, types: Object.fromEntries(org.issueTypes.nodes.map((t) => [t.name, t.id])) };
}

/** The node id of a label of the repository, by name. */
export async function labelId(name) {
  const data = await graphql(`query($o:String!,$r:String!,$n:String!){ repository(owner:$o,name:$r){ label(name:$n){ id } } }`, {
    o: OWNER,
    r: REPO,
    n: name,
  });
  return data.repository.label?.id ?? null;
}
