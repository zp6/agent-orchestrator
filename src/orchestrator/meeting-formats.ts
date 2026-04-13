/**
 * Meeting format definitions — structured templates for different
 * types of team discussions.
 *
 * Each format defines: purpose, round prompts, participant selection,
 * synthesis prompt, and expected output. The facilitator agent picks
 * the appropriate format based on the meeting request.
 */

export interface MeetingFormatRound {
  name: string;
  prompt: string;
  maxWords: number;
}

export interface MeetingFormat {
  id: string;
  name: string;
  emoji: string;
  purpose: string;
  when: string;
  rounds: MeetingFormatRound[];
  participantSelection: "all" | "relevant" | "involved";
  synthesisPrompt: string;
  expectedOutput: string;
}

export const MEETING_FORMATS: Record<string, MeetingFormat> = {
  rfc: {
    id: "rfc",
    name: "RFC (Request for Comments)",
    emoji: "📋",
    purpose: "Structured feedback on an architectural or design proposal",
    when: "Before making a significant technical decision that affects multiple agents or repos",
    rounds: [
      {
        name: "Proposal",
        prompt: `The meeting organiser has submitted a proposal for team review. Read the proposal carefully, then provide your perspective (under 200 words):

1. **Understanding**: Summarise the proposal in one sentence to confirm you understood it
2. **Support**: What aspects do you agree with? What's well-thought-out?
3. **Concerns**: What risks, edge cases, or problems do you see?
4. **Questions**: What's unclear or needs more detail?`,
        maxWords: 200,
      },
      {
        name: "Discussion",
        prompt: `Round 2: You've seen everyone's feedback. Now engage (under 150 words):

1. **Respond to concerns**: Address concerns raised by others — do you share them or disagree?
2. **Alternatives**: If you see a better approach, describe it concisely
3. **Blockers**: Is there anything that should prevent this from proceeding?`,
        maxWords: 150,
      },
      {
        name: "Convergence",
        prompt: `Final round: Based on all feedback, state your position (under 100 words):

1. **Vote**: Approve / Approve with changes / Block
2. **Key condition**: If "approve with changes", what MUST change?
3. **Action**: What's the immediate next step?`,
        maxWords: 100,
      },
    ],
    participantSelection: "all",
    synthesisPrompt: `Synthesise this RFC discussion into a decision record. Produce JSON:
{
  "decision": "approved|approved_with_changes|blocked",
  "summary": "1-2 sentence summary of the decision",
  "conditions": ["changes required before proceeding"],
  "dissenting_views": ["notable disagreements"],
  "action_items": [{"description": "...", "owner": "agent-name", "priority": "high|medium|low"}],
  "next_steps": "what happens now"
}`,
    expectedOutput: "Decision record with rationale, conditions, dissenting views, and action items",
  },

  retrospective: {
    id: "retrospective",
    name: "Retrospective",
    emoji: "🔄",
    purpose: "Reflect on what happened, learn from it, and improve",
    when: "After a milestone, incident, sprint, or time period",
    rounds: [
      {
        name: "Reflect",
        prompt: `This is a retrospective. Reflect on the topic honestly (under 200 words):

1. **What went well**: Specific things that worked. Reference PRs, issues, or outcomes.
2. **What didn't go well**: Problems, friction, failures. Be specific, not vague.
3. **What to change**: One concrete improvement suggestion with clear action.`,
        maxWords: 200,
      },
      {
        name: "Prioritise",
        prompt: `Round 2: You've seen everyone's reflections. Now prioritise (under 150 words):

1. **Top improvement**: Which suggestion from any agent would have the most impact?
2. **Quick win**: Which improvement could be done this week?
3. **Owner**: Who should own the top improvement? (Can be yourself)`,
        maxWords: 150,
      },
    ],
    participantSelection: "all",
    synthesisPrompt: `Synthesise this retrospective into improvement actions. Produce JSON:
{
  "summary": "2-3 sentence summary",
  "went_well": ["top 3 positives"],
  "needs_improvement": ["top 3 issues"],
  "action_items": [{"description": "...", "owner": "agent-name", "priority": "high|medium|low"}],
  "quick_wins": ["things that can be done this week"]
}`,
    expectedOutput: "Improvement actions with owners and quick wins",
  },

  "design-review": {
    id: "design-review",
    name: "Design Review",
    emoji: "🏗️",
    purpose: "Evaluate a proposed design before implementation begins",
    when: "Before starting work on a large feature or architectural change",
    rounds: [
      {
        name: "Present & Review",
        prompt: `A design is being presented for review. Evaluate it from your domain expertise (under 200 words):

1. **Feasibility**: Can this be implemented as described? What's missing?
2. **Risks**: What could go wrong? What are the failure modes?
3. **Your domain impact**: How does this affect your area of responsibility?
4. **Alternatives**: Is there a simpler or better approach?`,
        maxWords: 200,
      },
      {
        name: "Verdict",
        prompt: `Round 2: Based on all feedback, give your verdict (under 100 words):

1. **Go / No-go / Needs revision**: Should implementation proceed?
2. **Must-address**: If "needs revision", what MUST change before proceeding?
3. **Offer**: Can you help with any aspect of the implementation?`,
        maxWords: 100,
      },
    ],
    participantSelection: "relevant",
    synthesisPrompt: `Synthesise this design review. Produce JSON:
{
  "verdict": "go|no_go|needs_revision",
  "summary": "1-2 sentence verdict",
  "risks_identified": ["risk 1", "risk 2"],
  "must_address": ["issues that must be resolved"],
  "action_items": [{"description": "...", "owner": "agent-name", "priority": "high|medium|low"}]
}`,
    expectedOutput: "Go/no-go decision with risks and required changes",
  },

  triage: {
    id: "triage",
    name: "Triage",
    emoji: "📊",
    purpose: "Review and prioritise a backlog of items",
    when: "When the issue backlog needs grooming or priorities need reassessing",
    rounds: [
      {
        name: "Categorise",
        prompt: `Review the items in the agenda from your domain perspective (under 200 words):

For each item relevant to your domain, categorise as:
- **Do now**: High priority, should be in the next sprint
- **Defer**: Valid but not urgent — schedule for later
- **Close**: Stale, duplicate, or no longer relevant

Give a 1-sentence reason for each categorisation.`,
        maxWords: 200,
      },
    ],
    participantSelection: "all",
    synthesisPrompt: `Synthesise this triage session. Produce JSON:
{
  "summary": "1-2 sentence summary",
  "do_now": [{"item": "...", "reason": "...", "owner": "agent-name"}],
  "defer": [{"item": "...", "reason": "..."}],
  "close": [{"item": "...", "reason": "..."}],
  "action_items": [{"description": "...", "owner": "agent-name", "priority": "high|medium|low"}]
}`,
    expectedOutput: "Prioritised list with do-now/defer/close dispositions",
  },

  "incident-postmortem": {
    id: "incident-postmortem",
    name: "Incident Post-mortem",
    emoji: "🚨",
    purpose: "Analyse a system failure, find root cause, and prevent recurrence",
    when: "After an outage, data loss, prolonged degradation, or cascading failure",
    rounds: [
      {
        name: "Timeline",
        prompt: `Reconstruct the incident timeline from your perspective (under 200 words):

1. **What you observed**: When did you first notice something was wrong? What symptoms?
2. **Your actions**: What did you do in response? Did it help or hurt?
3. **Dependencies**: What other agents or systems were affected from your view?

Be factual — timestamps, error messages, task IDs if you have them.`,
        maxWords: 200,
      },
      {
        name: "Root Cause",
        prompt: `Round 2: Based on the combined timeline, analyse the root cause (under 150 words):

1. **Contributing factors**: What conditions led to this incident?
2. **Root cause**: What was the single most important thing that went wrong?
3. **Why wasn't it caught?**: What monitoring, testing, or safeguard should have prevented this?`,
        maxWords: 150,
      },
      {
        name: "Prevention",
        prompt: `Round 3: Propose prevention measures (under 100 words):

1. **Immediate fix**: What should be done right now to prevent recurrence?
2. **Systemic fix**: What longer-term change would make this class of failure impossible?
3. **Detection**: How should we detect this earlier next time?`,
        maxWords: 100,
      },
    ],
    participantSelection: "involved",
    synthesisPrompt: `Synthesise this post-mortem. Produce JSON:
{
  "summary": "2-3 sentence incident summary",
  "timeline": ["chronological events"],
  "root_cause": "the primary root cause",
  "contributing_factors": ["factor 1", "factor 2"],
  "action_items": [{"description": "...", "owner": "agent-name", "priority": "high|medium|low"}],
  "prevention": ["systemic changes to prevent recurrence"],
  "detection": ["monitoring/alerting improvements"]
}`,
    expectedOutput: "Post-mortem document with timeline, root cause, and prevention actions",
  },

  "investigation-spike": {
    id: "investigation-spike",
    name: "Investigation Spike",
    emoji: "🔬",
    purpose: "Parallel exploration of a technical unknown from multiple angles",
    when: "When a technical question needs research before a decision can be made",
    rounds: [
      {
        name: "Investigate",
        prompt: `Investigate the topic from your domain expertise (under 200 words):

1. **Your angle**: What does this question look like from your perspective?
2. **Findings**: What do you know or can you determine about this?
3. **Constraints**: What limitations or requirements does your domain impose on the answer?`,
        maxWords: 200,
      },
      {
        name: "Synthesise",
        prompt: `Round 2: You've seen everyone's findings. Now synthesise (under 150 words):

1. **Consensus**: What do most agents agree on?
2. **Conflicts**: Where do findings contradict? How to resolve?
3. **Recommendation**: Based on all perspectives, what should we do?`,
        maxWords: 150,
      },
    ],
    participantSelection: "relevant",
    synthesisPrompt: `Synthesise this investigation. Produce JSON:
{
  "summary": "2-3 sentence summary of findings",
  "consensus": ["points of agreement"],
  "open_questions": ["unresolved issues"],
  "recommendation": "the recommended path forward",
  "action_items": [{"description": "...", "owner": "agent-name", "priority": "high|medium|low"}],
  "confidence": 0.0-1.0
}`,
    expectedOutput: "Findings summary with recommendation and confidence level",
  },
};

/** Get a format by ID, or null if not found. */
export function getFormat(id: string): MeetingFormat | null {
  return MEETING_FORMATS[id] ?? null;
}

/** List all available format IDs with short descriptions. */
export function listFormats(): Array<{ id: string; name: string; emoji: string; purpose: string }> {
  return Object.values(MEETING_FORMATS).map((f) => ({
    id: f.id,
    name: f.name,
    emoji: f.emoji,
    purpose: f.purpose,
  }));
}
