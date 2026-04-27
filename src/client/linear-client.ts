const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
const TEAM_KEY = "NEX";

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: {
    name: string;
  };
  updatedAt: string;
}

type GraphQLError = { message: string };
type GraphQLResponse<T> = { data?: T; errors?: GraphQLError[] };
type IssuesData = { issues: { nodes: LinearIssue[] } };

async function postGraphQL<T>(
  apiKey: string,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(LINEAR_GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  const payload = (await response.json()) as GraphQLResponse<T>;
  if (!response.ok) {
    throw new Error(`Linear GraphQL request failed with HTTP ${response.status}`);
  }
  if (payload.errors?.length) {
    throw new Error(payload.errors.map((error) => error.message).join("; "));
  }
  if (!payload.data) {
    throw new Error("Linear GraphQL request returned no data");
  }

  return payload.data;
}

export class LinearClient {
  constructor(private apiKey: string) {}

  async listIssues(stateName?: string): Promise<LinearIssue[]> {
    const hasState = typeof stateName === "string" && stateName.length > 0;
    const query = `query LinearIssues($teamKey: String!${hasState ? ", $stateName: String!" : ""}) {
      issues(
        filter: {
          team: { key: { eq: $teamKey } }
          ${hasState ? "state: { name: { eq: $stateName } }" : ""}
        }
      ) {
        nodes {
          id
          identifier
          title
          description
          state {
            name
          }
          updatedAt
        }
      }
    }`;

    const data = await postGraphQL<IssuesData>(this.apiKey, query, {
      teamKey: TEAM_KEY,
      ...(hasState ? { stateName } : {}),
    });

    return data.issues.nodes;
  }
}
