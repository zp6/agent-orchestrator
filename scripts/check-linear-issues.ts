#!/usr/bin/env node
/**
 * Check Linear issues assigned to the orchestrator in the NEX team.
 *
 * This script:
 * 1. Loads LINEAR_API_KEY from ~/.claude-orchestrator/.env
 * 2. Creates a LinearClient
 * 3. Queries for open issues in the NEX team
 * 4. Reports findings and status
 *
 * Usage: npx tsx scripts/check-linear-issues.ts
 *
 * Requires: LINEAR_API_KEY environment variable (from .env)
 */

import { promises as fs } from "fs";
import { homedir } from "os";
import { join } from "path";
import { LinearClient, type LinearIssue } from "../src/client/linear-client.js";
import { validateLinearCredential } from "../src/client/linear-credential-validator.js";

interface IssueReview {
  identifier: string;
  title: string;
  state: string;
  description: string | null;
  canAddress: boolean;
  notes: string;
}

function reviewIssue(issue: LinearIssue): IssueReview {
  // Determine if we can address this issue based on:
  // 1. Issue state (we can work on Todo, Backlog, In Progress)
  // 2. Issue scope (we only work on orchestrator-related issues)

  const canAddress = ["Todo", "Backlog", "In Progress"].includes(issue.state.name);

  let notes = "";
  if (issue.state.name === "Done") {
    notes = "Issue already completed.";
  } else if (!canAddress) {
    notes = `Cannot address: issue is in "${issue.state.name}" state.`;
  } else if (issue.title.toLowerCase().includes("orchestrator") ||
             issue.title.toLowerCase().includes("dispatcher") ||
             issue.title.toLowerCase().includes("routing") ||
             issue.title.toLowerCase().includes("linear")) {
    notes = "Orchestrator-scoped: can address.";
  } else {
    notes = "Not orchestrator-scoped: would require rerouting to appropriate agent.";
  }

  return {
    identifier: issue.identifier,
    title: issue.title,
    state: issue.state.name,
    description: issue.description,
    canAddress: canAddress && notes.includes("can address"),
    notes,
  };
}

async function main() {
  console.log("🔍 Checking Linear issues for claude-agent-orchestrator in NEX team...\n");

  // Validate LINEAR_API_KEY credential
  const validation = validateLinearCredential();

  if (!validation.valid) {
    console.error(`❌ ${validation.errorMessage}\n`);
    console.error("📋 To unblock:");
    validation.suggestions.forEach((suggestion) => {
      console.error(`   ${suggestion}`);
    });
    console.error("");

    console.log("ℹ️  When configured, this script will:");
    console.log("   1. Query Linear's NEX team for open issues");
    console.log("   2. Review each issue's scope and state");
    console.log("   3. Identify which issues can be addressed by the orchestrator");
    console.log("   4. Report findings and next steps\n");

    process.exit(1);
  }

  const apiKey = validation.apiKey!;

  // Create client and query issues
  const client = new LinearClient({ apiKey, teamKey: "NEX" });

  let issues: LinearIssue[];
  try {
    console.log("📡 Querying Linear API...");
    issues = await client.listIssues();
    console.log(`✓ Found ${issues.length} issues\n`);
  } catch (err) {
    console.error(`❌ Failed to query Linear: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  if (issues.length === 0) {
    console.log("✓ No open issues found in NEX team.");
    process.exit(0);
  }

  // Review each issue
  console.log("📋 Issue Review:");
  console.log("─".repeat(80));

  const reviews = issues.map(issue => reviewIssue(issue));
  const addressable = reviews.filter(r => r.canAddress);

  reviews.forEach((review, i) => {
    console.log(`\n${i + 1}. [${review.identifier}] ${review.title}`);
    console.log(`   State: ${review.state}`);
    console.log(`   Status: ${review.canAddress ? "✓ Can address" : "✗ Cannot address"}`);
    console.log(`   Notes: ${review.notes}`);
    if (review.description) {
      console.log(`   Description: ${review.description.substring(0, 100)}...`);
    }
  });

  // Summary
  console.log("\n" + "─".repeat(80));
  console.log(`\n📊 Summary:`);
  console.log(`   Total issues: ${issues.length}`);
  console.log(`   Addressable: ${addressable.length}`);
  console.log(`   Cannot address: ${reviews.length - addressable.length}`);

  if (addressable.length > 0) {
    console.log(`\n✓ Ready to address ${addressable.length} issue${addressable.length === 1 ? "" : "s"}:`);
    addressable.forEach(r => {
      console.log(`   - [${r.identifier}] ${r.title}`);
    });
  }

  process.exit(0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
