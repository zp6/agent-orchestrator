/**
 * Meeting-facilitator monthly goal widget — `/meeting-facilitator-goal` API payload builder.
 *
 * Provides `getMeetingFacilitatorGoalPayload()` for the orchestrator or dashboard
 * to mount as a `GET /meeting-facilitator-goal` endpoint:
 *
 *   import { getMeetingFacilitatorGoalPayload } from 'claude-orchestrator-reviewer';
 *
 *   app.get('/meeting-facilitator-goal', (_req, res) => {
 *     res.json(getMeetingFacilitatorGoalPayload(store));
 *   });
 *
 * The response shape (`MeetingFacilitatorGoalWidget`) tracks two monthly goals:
 *
 *  1. `core_logic_shipped`   — at least one approved implementation task for the agent.
 *  2. `meetings_facilitated` — five or more done tasks in the current calendar month.
 *
 * Dashboard rendering contract:
 *  - Render one progress bar per `goals` entry.
 *  - Use `overall_progress` for a top-level summary bar.
 *  - `all_goals_met: true` → green banner.  Otherwise show individual goal statuses.
 *  - `goal.met: false` with `goal.progress = 0` → highlight in amber to prompt action.
 */

import type { IMeetingFacilitatorGoalStore, MeetingFacilitatorGoalWidget } from "../state/types.js";

/**
 * Options for `getMeetingFacilitatorGoalPayload`.
 */
export interface MeetingFacilitatorGoalOptions {
  /**
   * SQL LIKE pattern to match the agent_name column in the tasks table.
   * Default: `'%meeting-facilitator%'`.
   */
  agentNamePattern?: string;
}

/**
 * Build the payload for the `GET /meeting-facilitator-goal` endpoint.
 *
 * Returns a `MeetingFacilitatorGoalWidget` ready to be `res.json()`-ed.
 * The current month resets at UTC midnight on the first of each month.
 *
 * @param store - A live `IMeetingFacilitatorGoalStore` instance.
 * @param opts  - Optional agent name pattern override.
 */
export function getMeetingFacilitatorGoalPayload(
  store: IMeetingFacilitatorGoalStore,
  opts: MeetingFacilitatorGoalOptions = {},
): MeetingFacilitatorGoalWidget {
  return store.getMeetingFacilitatorGoalWidget(opts.agentNamePattern);
}
