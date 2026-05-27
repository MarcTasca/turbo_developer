import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Phase = "idle" | "planning" | "coding" | "reviewing";

type WorkflowState = {
  active: boolean;
  task: string;
  phase: Phase;
  iteration: number;
  maxIterations: number;
  lastReview: string;
};

const state: WorkflowState = {
  active: false,
  task: "",
  phase: "idle",
  iteration: 0,
  maxIterations: 3,
  lastReview: "",
};

function textFromMessages(messages: any[]): string {
  const assistantMessages = messages.filter((m) => m?.role === "assistant");
  const last = assistantMessages[assistantMessages.length - 1];
  if (!last) return "";
  const content = last.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text ?? "";
        return "";
      })
      .join("\n");
  }
  return "";
}

function parseArgs(args: string): { task: string; maxIterations: number } {
  const match = args.match(/(?:^|\s)--max(?:-iterations)?=(\d+)/);
  const maxIterations = match ? Math.max(1, Math.min(10, Number(match[1]))) : 3;
  const task = args.replace(/(?:^|\s)--max(?:-iterations)?=\d+/g, " ").trim();
  return { task, maxIterations };
}

function plannerPrompt(task: string): string {
  return `You are PLANNER in a planner -> coder -> reviewer agentic coding workflow.

Task:
${task}

Plan using elite agentic coding best practices:
- Inspect the repository before deciding.
- Identify constraints, existing architecture, risky files, dependencies, commands, and tests.
- Produce a concise implementation plan with acceptance criteria.
- Do NOT edit files in this phase unless reading project docs requires tiny non-code notes; prefer read/bash inspection only.
- Include a test/verification strategy.
- Keep the plan actionable for the coder.

End with exactly:
AGENTIC_PLAN: READY`;
}

function coderPrompt(): string {
  return `You are CODER in the agentic workflow.

Implement the approved plan now.

Rules:
- Make the smallest correct change set.
- Read files before editing.
- Preserve existing style and architecture.
- Never commit secrets or auth/session data.
- Run relevant tests, lint, typecheck, or at least a targeted smoke check.
- If tests cannot run, explain why and do a static verification.
- Finish with a concise change summary and verification evidence.

If reviewer feedback exists, address it first:
${state.lastReview || "No reviewer feedback yet."}

End with exactly:
AGENTIC_CODE: READY_FOR_REVIEW`;
}

function reviewerPrompt(): string {
  return `You are REVIEWER in the agentic workflow.

Review the coder's latest changes with senior-level rigor.

Checklist:
- Diff correctness against the original task and plan.
- Bugs, edge cases, regressions, security/privacy issues.
- Test coverage and whether verification is meaningful.
- Simplicity, maintainability, style consistency.
- Ensure .pi/agent auth/session/bin state is never introduced; project .pi should contain only project skills/extensions unless explicitly requested.

Use tools to inspect git diff/status and relevant files. Do not modify code unless absolutely necessary; prefer review feedback.

Output:
1. Verdict: PASS or FAIL
2. Required fixes if FAIL
3. Optional improvements
4. Evidence reviewed

End with exactly one marker:
AGENTIC_REVIEW: PASS
or
AGENTIC_REVIEW: FAIL`;
}

function isSensitivePiPath(pathValue: unknown): boolean {
  if (typeof pathValue !== "string") return false;
  return /(^|\/)\.pi\/agent(\/|$)/.test(pathValue) || /(^|\/)\.pi\/.*auth.*\.json$/i.test(pathValue);
}

function bashTouchesSensitivePi(command: unknown): boolean {
  if (typeof command !== "string") return false;
  return /\.pi\/agent|\.pi\/.*auth.*\.json/i.test(command) && /\b(rm|mv|cp|cat|sed|tee|echo|touch|mkdir|chmod|chown|git\s+add)\b/.test(command);
}

export default function agenticWorkflow(pi: ExtensionAPI) {
  pi.registerCommand("agentic", {
    description: "Run planner -> coder -> reviewer loop. Usage: /agentic [--max=3] <task>",
    handler: async (args, ctx) => {
      const { task, maxIterations } = parseArgs(args);
      if (!task) {
        ctx.ui.notify("Usage: /agentic [--max=3] <task>", "warning");
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify("Agent is busy. Start /agentic when idle.", "warning");
        return;
      }

      state.active = true;
      state.task = task;
      state.phase = "planning";
      state.iteration = 0;
      state.maxIterations = maxIterations;
      state.lastReview = "";

      pi.appendEntry("agentic-workflow", {
        event: "start",
        task,
        maxIterations,
        timestamp: Date.now(),
      });
      pi.setSessionName(`agentic: ${task.slice(0, 60)}`);
      ctx.ui.notify(`Agentic workflow started (max ${maxIterations} review loops)`, "info");
      pi.sendUserMessage(plannerPrompt(task));
    },
  });

  pi.registerCommand("agentic-stop", {
    description: "Stop the active agentic workflow",
    handler: async (_args, ctx) => {
      state.active = false;
      state.phase = "idle";
      pi.appendEntry("agentic-workflow", { event: "stop", timestamp: Date.now() });
      ctx.ui.notify("Agentic workflow stopped", "info");
    },
  });

  pi.registerCommand("agentic-status", {
    description: "Show the current agentic workflow status",
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        state.active
          ? `Agentic active: phase=${state.phase}, iteration=${state.iteration}/${state.maxIterations}`
          : "Agentic workflow idle",
        "info",
      );
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    ctx.ui.notify("Agentic workflow loaded: use /agentic <task>", "info");
  });

  pi.on("tool_call", async (event: any) => {
    if (["write", "edit", "read"].includes(event.toolName) && isSensitivePiPath(event.input?.path)) {
      return { block: true, reason: "Project must not access .pi/agent auth/session/bin state; use ~/.pi for authentication." };
    }
    if (event.toolName === "bash" && bashTouchesSensitivePi(event.input?.command)) {
      return { block: true, reason: "Blocked command touching .pi/agent auth/session/bin state." };
    }
  });

  pi.on("agent_end", async (event: any, ctx) => {
    if (!state.active) return;

    const lastText = textFromMessages(event.messages ?? []);

    if (state.phase === "planning") {
      if (!lastText.includes("AGENTIC_PLAN: READY")) {
        ctx.ui.notify("Planner did not emit ready marker; continuing to coder anyway.", "warning");
      }
      state.phase = "coding";
      state.iteration = 1;
      pi.appendEntry("agentic-workflow", { event: "plan-ready", timestamp: Date.now() });
      pi.sendUserMessage(coderPrompt(), { deliverAs: "followUp" });
      return;
    }

    if (state.phase === "coding") {
      state.phase = "reviewing";
      pi.appendEntry("agentic-workflow", { event: "code-ready", iteration: state.iteration, timestamp: Date.now() });
      pi.sendUserMessage(reviewerPrompt(), { deliverAs: "followUp" });
      return;
    }

    if (state.phase === "reviewing") {
      state.lastReview = lastText;
      const passed = /AGENTIC_REVIEW:\s*PASS/i.test(lastText);
      const failed = /AGENTIC_REVIEW:\s*FAIL/i.test(lastText);

      if (passed) {
        state.active = false;
        state.phase = "idle";
        pi.appendEntry("agentic-workflow", { event: "pass", iteration: state.iteration, timestamp: Date.now() });
        ctx.ui.notify("Agentic workflow completed: reviewer passed", "info");
        return;
      }

      if (!failed) {
        ctx.ui.notify("Reviewer did not emit PASS/FAIL marker; treating as FAIL.", "warning");
      }

      if (state.iteration >= state.maxIterations) {
        state.active = false;
        state.phase = "idle";
        pi.appendEntry("agentic-workflow", { event: "max-iterations", iteration: state.iteration, timestamp: Date.now() });
        ctx.ui.notify("Agentic workflow stopped: max iterations reached", "warning");
        return;
      }

      state.iteration += 1;
      state.phase = "coding";
      pi.appendEntry("agentic-workflow", { event: "review-fail", iteration: state.iteration - 1, timestamp: Date.now() });
      pi.sendUserMessage(coderPrompt(), { deliverAs: "followUp" });
    }
  });
}
