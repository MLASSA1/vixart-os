import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { assignTask, createTask, projectHealth, unassigned, workload } from './work-tools';

/**
 * VIXART OS — Le Chef.
 *
 * The work agent. Reads who is carrying what, what nobody has picked up, and
 * which jobs are slipping; can hand a task to someone, open a new one, and move
 * a date. It cannot mark anything done — that is the two-step human sign-off,
 * refused by a column grant and again by a trigger.
 *
 * This is a SECOND surface, not a sub-agent picker. The locked rule is that the
 * user never chooses which agent to address — and they do not: the page decides.
 * Money questions live on /finance with Le Comptable; work questions live on
 * /projects with Le Chef. Different job, different reader, different role in the
 * database. Neither can reach the other's tables.
 */

const MODEL = 'claude-opus-5';

const SYSTEM = `You are Le Chef, the work agent for VIXART, a Business Growth
Engineering agency in Agadir. You work with Amin (founder) and Mohamed Amine, who
moderates the work — assigns it and signs it off.

WHAT YOU ARE FOR
Seeing who is carrying what, what is unassigned, and which projects are slipping.
You can hand work to people and open new tasks. You help distribute; you do not
decide the work is finished.

HOW YOU MUST ANSWER

1. NEVER state a figure you did not get from a tool. No estimating who "seems"
   busy. If a tool returned nothing, say so.

2. ALWAYS cite your source. Every result carries \`sources\` with the table and
   the row ids. Name what you read.

3. ALWAYS surface caveats, in the body of the answer, not as a footnote. The two
   that matter most right now:
   - NO CAPACITY IS RECORDED for anyone. You do not know how many hours a week
     anybody works. So you may report open task counts and logged minutes, and
     you may NEVER express load as a percentage or call someone "at capacity" or
     "overloaded" as though it were measured. Whether someone has too much is a
     judgement for Mohamed Amine, and you should say so.
   - Logged effort is probably incomplete. If nobody has logged minutes, that is
     missing data, not an idle team. Never read it as idleness.

4. NOBODY IS NOTIFIED. Assigning a task does not tell the person. There is no
   email, no WhatsApp, no notification of any kind. Every time you assign or
   create something, say plainly that they still need to be told.

5. You CANNOT mark work done, submit it for review, or reopen it. The database
   refuses you. If asked, explain that finishing work is a person's call: the
   assignee submits it, Mohamed Amine signs it off.

6. You cannot see money. Not invoices, not costs, not what anyone is paid or what
   a client is worth. If asked, say that is Le Comptable's side of the house, on
   the Finance screen — and do not speculate.

7. When suggesting who should take something, give your reasoning from the
   figures you actually have — current open tasks, what is overdue, what is
   already submitted and waiting — and present it as a suggestion for a human to
   confirm, not a decision.

8. Answer in the language you are written to. Keep it short. Today is ${new Date().toISOString().slice(0, 10)}.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'workload',
    description:
      'Who is carrying what: open tasks, overdue, due this week, work submitted and waiting for sign-off, and minutes logged in the last 30 days. Use for "who is busy", "who can take this", "how is the team doing".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'unassigned',
    description:
      'Tasks nobody has picked up, and active projects with no tasks at all. Use for "what needs assigning", "what is falling through".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'project_health',
    description:
      'Projects that are planned, active or on hold: how late, how many tasks open and overdue, how many awaiting sign-off, how long since anything moved. Use for "what is slipping", "how is X going".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'assign_task',
    description:
      'Hands a task to a person, optionally with a due date. Does NOT notify them. Cannot change status.',
    input_schema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task uuid.' },
        userId: { type: 'string', description: 'Person uuid, from workload.' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD. Optional.' },
      },
      required: ['taskId', 'userId'],
    },
  },
  {
    name: 'create_task',
    description:
      'Opens a new task on a project. Always starts unstarted. Does NOT notify anyone.',
    input_schema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project uuid.' },
        title: { type: 'string', description: 'What the task is.' },
        assigneeId: { type: 'string', description: 'Person uuid. Optional.' },
        dueDate: { type: 'string', description: 'YYYY-MM-DD. Optional.' },
        priority: { type: 'string', description: 'low | normal | high | urgent.' },
      },
      required: ['projectId', 'title'],
    },
  },
];

async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null);

  switch (name) {
    case 'workload':
      return workload();
    case 'unassigned':
      return unassigned();
    case 'project_health':
      return projectHealth();
    case 'assign_task':
      return assignTask(str('taskId') ?? '', str('userId') ?? '', str('dueDate'));
    case 'create_task':
      return createTask(
        str('projectId') ?? '',
        str('title') ?? '',
        str('assigneeId'),
        str('dueDate'),
        str('priority'),
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export interface ChefTurn {
  reply: string;
  toolsUsed: Array<{ name: string; input: Record<string, unknown> }>;
  sources: Array<{ table: string; rows: number }>;
}

export function isConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/** One turn. Same manual loop as Le Comptable, same reasons. */
export async function ask(history: Anthropic.MessageParam[]): Promise<ChefTurn> {
  if (!isConfigured()) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set, so Le Chef is not available. Every other screen works normally.',
    );
  }

  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [...history];
  const toolsUsed: ChefTurn['toolsUsed'] = [];
  const sources = new Map<string, number>();
  const MAX_TURNS = 8;

  for (let turn = 0; turn < MAX_TURNS; turn += 1) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      thinking: { type: 'adaptive' },
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === 'refusal') {
      return {
        reply: 'I stopped on that one. Try asking it differently.',
        toolsUsed,
        sources: [...sources].map(([table, rows]) => ({ table, rows })),
      };
    }

    messages.push({ role: 'assistant', content: response.content });

    const calls = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    if (calls.length === 0) {
      const reply = response.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return {
        reply: reply || 'I could not put an answer together for that.',
        toolsUsed,
        sources: [...sources].map(([table, rows]) => ({ table, rows })),
      };
    }

    const results = await Promise.all(
      calls.map(async (call): Promise<Anthropic.ToolResultBlockParam> => {
        const input = (call.input ?? {}) as Record<string, unknown>;
        toolsUsed.push({ name: call.name, input });
        try {
          const result = (await runTool(call.name, input)) as {
            sources?: Array<{ table: string; total?: number; ids: string[] }>;
          };
          for (const s of result.sources ?? []) {
            sources.set(s.table, (sources.get(s.table) ?? 0) + (s.total ?? s.ids.length));
          }
          return { type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(result) };
        } catch (error) {
          return {
            type: 'tool_result',
            tool_use_id: call.id,
            is_error: true,
            content: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    messages.push({ role: 'user', content: results });
  }

  return {
    reply: 'That took more lookups than I allow in one go. Ask it in smaller pieces.',
    toolsUsed,
    sources: [...sources].map(([table, rows]) => ({ table, rows })),
  };
}
