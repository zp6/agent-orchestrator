/**
 * ImprovementDetector — analyzes recent tasks for cross-cutting product improvements.
 *
 * LLM calls are delegated to the ReviewerClient (reviewer agent pool).
 * This module is now a thin wrapper that coordinates the call.
 */
import { ReviewerClient } from "../client/reviewer-client.js";
import type { OrchestratorConfig } from "../config/schema.js";
import type { Task } from "../state/store.js";
import { createLogger } from "../service/logger.js";

export type { DetectedImprovement } from "../client/reviewer-client.js";

export class ImprovementDetector {
  private log = createLogger("improvement-detector");
  private reviewerClient: ReviewerClient;

  constructor(config: OrchestratorConfig, reviewerClient?: ReviewerClient) {
    this.reviewerClient = reviewerClient ?? new ReviewerClient(config);
  }

  async analyze(recentTasks: Task[]): Promise<import("../client/reviewer-client.js").DetectedImprovement[]> {
    return this.reviewerClient.analyzeImprovements(recentTasks);
  }
}
