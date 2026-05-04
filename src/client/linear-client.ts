/**
 * Minimal Linear API client — issue #1223 parts 1 & 2.
 *
 * Wraps Linear's GraphQL API for the Nexus team (NEX). Authentication uses a
 * personal API key passed in the Authorization header (no `Bearer` prefix —
 * that is Linear's convention).
 *
 * Methods: listIssues, getIssue, commentOnIssue.
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
  teams: {
    nodes: Array<{
      issues: {
        nodes: LinearIssue[];
      };
    }>;
  };
}

interface GetIssueResponse {
  issue: LinearIssue | null;
}

interface CreateCommentResponse {
  commentCreate: {
    success: boolean;
    comment: { id: string } | null;
  };
}

export class LinearClient {
  private readonly apiKey: string;
  private readonly teamKey: string;
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LinearClientOptions) {
    this.apiKey = options.apiKey;
    this.teamKey = options.teamKey ?? "NEX";
    this.endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * List issues for the configured team, optionally filtered by state.
   * @param stateName Optional state filter (e.g., "Backlog", "Todo", "In Progress", "Done")
   * @returns Array of issues matching the criteria
   */
  async listIssues(stateName?: string): Promise<LinearIssue[]> {
    // Linear's GraphQL `team` field requires `id`, not `key`. To look up by team
    // key (e.g., "NEX"), use the `teams(filter:)` collection query instead.
    const issuesFilter = stateName ? `(filter: { state: { name: { eq: "${stateName}" } } })` : "";

    const query = `
      query {
        teams(filter: { key: { eq: "${this.teamKey}" } }) {
          nodes {
            issues${issuesFilter} {
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
          }
        }
      }
    `;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Authorization": this.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as GraphQLResponse<ListIssuesResponse>;

    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
    }

    // teams(filter:) returns a collection; with a unique key filter we expect
    // at most one team. If empty, return [] rather than throwing.
    return json.data?.teams.nodes[0]?.issues.nodes ?? [];
  }

  /**
   * Fetch a single issue by its Linear UUID.
   * Returns null if the issue is not found or the response is empty.
   */
  async getIssue(issueId: string): Promise<LinearIssue | null> {
    const query = `
      query {
        issue(id: "${issueId}") {
          id
          identifier
          title
          description
          state { name }
          updatedAt
        }
      }
    `;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "Authorization": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as GraphQLResponse<GetIssueResponse>;
    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
    }

    return json.data?.issue ?? null;
  }

  /**
   * Post a comment on a Linear issue.
   * Throws if the API call fails or the mutation returns success: false.
   */
  async commentOnIssue(issueId: string, body: string): Promise<void> {
    const mutation = `
      mutation {
        commentCreate(input: { issueId: "${issueId}", body: ${JSON.stringify(body)} }) {
          success
          comment { id }
        }
      }
    `;

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "Authorization": this.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ query: mutation }),
    });

    if (!response.ok) {
      throw new Error(`Linear API error: ${response.status} ${response.statusText}`);
    }

    const json = (await response.json()) as GraphQLResponse<CreateCommentResponse>;
    if (json.errors?.length) {
      throw new Error(`GraphQL errors: ${json.errors.map((e) => e.message).join("; ")}`);
    }

    if (!json.data?.commentCreate.success) {
      throw new Error(`commentCreate returned success: false for issue ${issueId}`);
    }
  }
}
