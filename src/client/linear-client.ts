/**
 * Minimal Linear API client — issue #1223 part 1/N.
 *
 * Wraps Linear's GraphQL API for the Nexus team (NEX). Authentication uses a
 * personal API key passed in the Authorization header (no `Bearer` prefix —
 * that is Linear's convention).
 *
 * This part exposes only `listIssues`. Subsequent parts will add `getIssue`,
 * `commentOnIssue`, `createIssue`, and the trigger / verifier wiring.
 */

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

export interface LinearIssueState {
  name: string;
}

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  state: LinearIssueState;
  updatedAt: string;
}

export interface LinearClientOptions {
  apiKey: string;
  teamKey?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: Array<{ message: string }>;
}

interface ListIssuesResponse {
  team: {
    issues: {
      nodes: LinearIssue[];
    };
  };
}

export class LinearClient {
  private readonly apiKey: string;
  private readonly teamKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LinearClientOptions) {
    if (!options.apiKey) {
      throw new Error("LinearClient: apiKey is required");
    }
    this.apiKey = options.apiKey;
    this.teamKey = options.teamKey ?? "NEX";
    this.endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * List issues for the configured team, optionally filtered by state name
   * (e.g. "Backlog", "Todo", "In Progress", "Done").
   */
  async listIssues(stateName?: string): Promise<LinearIssue[]> {
    const query = `
      query TeamIssues($teamKey: String!, $first: Int!) {
        team(id: $teamKey) {
          issues(first: $first) {
            nodes {
              id
              identifier
              title
              description
              state { name }
              updatedAt
            }
          }
        }
      }
    `;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: this.apiKey,
      },
      body: JSON.stringify({
        query,
        variables: { teamKey: this.teamKey, first: 100 },
      }),
    });

    if (!response.ok) {
      throw new Error(`Linear API error: HTTP ${response.status}`);
    }

    const body = (await response.json()) as GraphQLResponse<ListIssuesResponse>;
    if (body.errors && body.errors.length > 0) {
      throw new Error(`Linear API error: ${body.errors[0].message}`);
    }
    if (!body.data) {
      throw new Error("Linear API error: empty response");
    }

    const issues = body.data.team.issues.nodes;
    if (!stateName) return issues;
    return issues.filter((i) => i.state.name === stateName);
  }
}
