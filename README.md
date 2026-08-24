# MCP GitHub PR Reviewer 🤖

A locally hosted [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that enables AI assistants (like Claude Desktop and Cursor) to autonomously review GitHub Pull Requests.

## Features
- **`list_prs`**: Fetches open pull requests for a given repository.
- **`get_pr_diff`**: Retrieves the raw git diff of a specific PR.
- **`submit_review`**: Posts structured reviews (APPROVE, COMMENT, REQUEST_CHANGES) directly to GitHub.
- **Dynamic Resource**: Injects standard corporate code review guidelines into the AI's context window to standardize evaluations.

## Tech Stack
- Node.js & TypeScript
- `@modelcontextprotocol/sdk` (Stdio Transport)
- `zod` (Strict runtime schema validation)
- GitHub REST API

## How it Works
This server acts as a bridge between an LLM and GitHub. Using the MCP standard, the AI can discover these tools, determine when to use them, validate the inputs via Zod schemas, and execute multi-step reasoning to read code and enforce review guidelines—all without human intervention.
