import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

// --- 1. ZOD SCHEMAS (Validation Layer) ---
const SubmitReviewArgsSchema = z.object({
  owner: z.string().min(1).describe("The GitHub repository owner"),
  repo: z.string().min(1).describe("The repository name"),
  pull_number: z
    .number()
    .int()
    .positive()
    .describe("The PR number to submit review for"),
  event: z
    .enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"])
    .describe("The review action: APPROVE, REQUEST_CHANGES, or COMMENT"),
  body: z
    .string()
    .min(1)
    .describe("The markdown review feedback summary and critique"),
});

const ListPRsArgsSchema = z.object({
  owner: z
    .string()
    .min(1)
    .describe(
      "The GitHub repository owner (e.g., 'facebook' or your username)",
    ),
  repo: z.string().min(1).describe("The repository name (e.g., 'react')"),
  state: z
    .enum(["open", "closed", "all"])
    .optional()
    .default("open")
    .describe("State of the PRs to list"),
});
const GetPRDiffArgsSchema = z.object({
  owner: z.string().min(1).describe("The GitHub repository owner"),
  repo: z.string().min(1).describe("The repository name"),
  pull_number: z
    .number()
    .int()
    .positive()
    .describe("The PR number to get the diff for"),
});

// --- 2. GITHUB API HELPER ---
async function githubRequest(endpoint: string, options: RequestInit = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN environment variable is not set. Please provide a valid GitHub PAT.",
    );
  }

  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "mcp-github-reviewer",
      Authorization: `Bearer ${token}`,
      ...((options.headers as Record<string, string>) || {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`GitHub API Error (${response.status}): ${errorBody}`);
  }

  return response;
}

// --- 3. MCP SERVER INITIALIZATION ---
const server = new Server(
  {
    name: "github-pr-reviewer",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// --- 4. TOOL DISCOVERY HANDLER ---
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "list_prs",
        description:
          "Fetch a list of pull requests from a GitHub repository to inspect PR numbers, titles, and authors.",
        inputSchema: {
          type: "object",
          properties: {
            owner: {
              type: "string",
              description: "The GitHub owner/organization (e.g., 'octocat')",
            },
            repo: {
              type: "string",
              description: "The repository name (e.g., 'Hello-World')",
            },
            state: {
              type: "string",
              enum: ["open", "closed", "all"],
              description: "Filter PRs by state (default: 'open')",
            },
          },
          required: ["owner", "repo"],
        },
      },
      {
        name: "get_pr_diff",
        description:
          "Get the raw diff (code changes) of a specific pull request to review the code.",
        inputSchema: {
          type: "object",
          properties: {
            owner: {
              type: "string",
              description: "The GitHub owner/organization",
            },
            repo: { type: "string", description: "The repository name" },
            pull_number: { type: "number", description: "The PR number" },
          },
          required: ["owner", "repo", "pull_number"],
        },
      },
      {
        name: "submit_review",
        description:
          "Submit a structured code review (APPROVE, REQUEST_CHANGES, or COMMENT) on a GitHub Pull Request.",
        inputSchema: {
          type: "object",
          properties: {
            owner: {
              type: "string",
              description: "The GitHub owner/organization",
            },
            repo: { type: "string", description: "The repository name" },
            pull_number: { type: "number", description: "The PR number" },
            event: {
              type: "string",
              enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"],
              description:
                "Review decision: APPROVE, REQUEST_CHANGES, or COMMENT",
            },
            body: {
              type: "string",
              description: "Detailed Markdown feedback text",
            },
          },
          required: ["owner", "repo", "pull_number", "event", "body"],
        },
      },
    ],
  };
});

// --- 5. TOOL EXECUTION HANDLER ---
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "list_prs") {
    // Validate the LLM's arguments using Zod
    const parseResult = ListPRsArgsSchema.safeParse(args);
    if (!parseResult.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${parseResult.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { owner, repo, state } = parseResult.data;

    try {
      const response = await githubRequest(
        `/repos/${owner}/${repo}/pulls?state=${state}&per_page=10`,
      );
      const prs = await response.json();

      // Format a concise summary for the LLM
      const summary = (prs as any[]).map((pr) => ({
        number: pr.number,
        title: pr.title,
        user: pr.user?.login,
        state: pr.state,
        created_at: pr.created_at,
        html_url: pr.html_url,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(summary, null, 2),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to list PRs: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  if (name === "get_pr_diff") {
    const parseResult = GetPRDiffArgsSchema.safeParse(args);
    if (!parseResult.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${parseResult.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { owner, repo, pull_number } = parseResult.data;

    try {
      // Note the special Accept header here! GitHub requires this specific header to return a raw diff string.
      const response = await githubRequest(
        `/repos/${owner}/${repo}/pulls/${pull_number}`,
        {
          headers: {
            Accept: "application/vnd.github.v3.diff",
          },
        },
      );

      const diffText = await response.text();

      return {
        content: [{ type: "text", text: diffText }],
      };
    } catch (error: any) {
      return {
        content: [
          { type: "text", text: `Failed to get PR diff: ${error.message}` },
        ],
        isError: true,
      };
    }
  }

  if (name === "submit_review") {
    const parseResult = SubmitReviewArgsSchema.safeParse(args);
    if (!parseResult.success) {
      throw new McpError(
        ErrorCode.InvalidParams,
        `Invalid parameters: ${parseResult.error.issues.map((i) => i.message).join(", ")}`,
      );
    }

    const { owner, repo, pull_number, event, body } = parseResult.data;

    try {
      const response = await githubRequest(
        `/repos/${owner}/${repo}/pulls/${pull_number}/reviews`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ event, body }),
        },
      );

      const reviewData = (await response.json()) as any;

      return {
        content: [
          {
            type: "text",
            text: `Successfully submitted review (#${reviewData.id}) with status ${event} on PR #${pull_number}.\nURL: ${reviewData.html_url}`,
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to submit review: ${error.message}`,
          },
        ],
        isError: true,
      };
    }
  }

  throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
});

// --- 6. START SERVER ---
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP GitHub Reviewer Server running on stdio");
}

main().catch(console.error);
