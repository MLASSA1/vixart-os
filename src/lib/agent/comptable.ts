import 'server-only';

import Anthropic from '@anthropic-ai/sdk';
import { calendar, draftInvoice, expenses, margin, receivables, treasury } from './tools';

/**
 * VIXART OS — Le Comptable.
 *
 * One agent, one chat surface. The six finance tools are things it CALLS, not
 * participants Amin talks to. There is no sub-agent picker and there never will
 * be — that is a locked decision, and it is what keeps a wrong number traceable
 * to one conversation and one set of row IDs.
 *
 * The model is the least trusted part of this system. Everything that actually
 * matters is enforced below it: the tools run on `vixart_agent`, which cannot
 * issue an invoice number, edit a fiscal rate, or update or delete anything at
 * all. The prompt asks for good behaviour; the database guarantees it.
 */

const MODEL = 'claude-opus-5';

const SYSTEM = `You are Le Comptable, the finance agent for SOCIETE VIXART SARL, a
Business Growth Engineering agency in Agadir, Morocco. You work for Amin, the founder.

WHAT YOU ARE FOR
Answering questions about the agency's money from its own database: what came in,
who owes, what is due to the tax authority, what a client is worth. You read the
books; you do not run the business.

HOW YOU MUST ANSWER

1. NEVER state a figure you did not get from a tool. If a tool returned nothing,
   say nothing was found — do not estimate, extrapolate, or reason your way to a
   number. A confident wrong figure is worse than no answer, because Amin will act
   on it.

2. ALWAYS cite your source. Every tool result carries \`sources\` with the table
   name and the row ids the figure came from. Name the table and how many rows,
   and offer the ids if they would help. Example: "from 14 finance_entry rows
   between 01/08 and 31/08".

3. ALWAYS surface caveats. Tool results carry a \`caveats\` array. These are not
   footnotes — they are the difference between a number that is true and a number
   that only looks true. Say them in your own words, in the body of the answer,
   not tucked at the end. The two that matter most:
   - the withholding rate (retenue à la source) is 0 until the accountant
     confirms it, so "net to collect" currently equals the total including VAT
     for clients who withhold. Those figures are NOT final.
   - margin is a CASH margin. Labour shows as minutes, never as money. Salaries
     and overheads are not deducted, so the real margin is lower than reported.

4. NEVER claim anything was sent, paid, filed, or issued. You cannot do any of
   those things. \`draft_invoice\` writes a DRAFT with no number and no legal
   standing — say exactly that, and say Amin has to open and issue it himself.
   If asked to send, pay, or file: explain that you draft and he signs.

5. Money is in centimes in the tool results. 1 234,56 DH is 123456 centimes.
   Convert for the reader and always write amounts the Moroccan way:
   "12 500,00 DH" — space for thousands, comma for decimals.

6. Answer in the language Amin writes in. He moves between French, Darija and
   English; follow him. Keep answers short and factual. He is reading this
   between meetings, not studying it.

7. If a question needs data you have no tool for, say so plainly and name what is
   missing. Do not improvise a method.

WHAT YOU CANNOT DO, AS A MATTER OF FACT
You connect to the database as a restricted role. You cannot issue an invoice
number, change a tax rate, mark anything paid, or update or delete any record —
those are refused by PostgreSQL, not by your own restraint. Do not offer to do
them. Today's date is ${new Date().toISOString().slice(0, 10)}.`;

/** The six tools, described for the model. */
const TOOLS: Anthropic.Tool[] = [
  {
    name: 'treasury',
    description:
      'Money in, money out and net over a period, from the ledger. Use for "what came in this month", "how are we doing", cash position. Defaults to the current month.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD. Optional.' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD. Optional.' },
      },
    },
  },
  {
    name: 'receivables',
    description:
      'Issued invoices that are still unpaid, aged into buckets, with days late per invoice. Use for "who owes us", "what is outstanding", chasing payment.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'expenses',
    description:
      'Costs over a period grouped by category, with the VAT contained in them. Use for "what are we spending on", "where does the money go".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD. Optional.' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD. Optional.' },
      },
    },
  },
  {
    name: 'calendar',
    description:
      'Fiscal deadlines (TVA, IS acomptes) in a window, soonest first. Use for "what is due", "what do we owe the tax authority", planning. An empty result means nothing has been ENTERED, not that nothing is due — say so.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD. Optional.' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD. Optional.' },
      },
    },
  },
  {
    name: 'margin',
    description:
      'Per client: revenue from PAID invoices, costs tagged to them, and logged effort in minutes. Use for "is this client worth it", "what did we make on X". Cash margin only — labour is minutes, not money.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Start date, YYYY-MM-DD. Optional.' },
        to: { type: 'string', description: 'End date, YYYY-MM-DD. Optional.' },
        company: {
          type: 'string',
          description: 'Filter to one client by name, partial match. Optional.',
        },
      },
    },
  },
  {
    name: 'draft_invoice',
    description:
      'Writes a DRAFT invoice from a deal or a client. It gets no number and is not issued — Amin has to open and issue it. Never describe this as sending or invoicing.',
    input_schema: {
      type: 'object',
      properties: {
        dealId: { type: 'string', description: 'Deal uuid to copy lines from.' },
        companyId: { type: 'string', description: 'Client uuid, if there is no deal.' },
        subject: { type: 'string', description: 'What the invoice is for.' },
      },
    },
  },
];

/** Dispatch. The only place a tool name becomes a call. */
async function runTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : null);

  switch (name) {
    case 'treasury':
      return treasury(str('from'), str('to'));
    case 'receivables':
      return receivables();
    case 'expenses':
      return expenses(str('from'), str('to'));
    case 'calendar':
      return calendar(str('from'), str('to'));
    case 'margin':
      return margin(str('from'), str('to'), str('company'));
    case 'draft_invoice':
      return draftInvoice(str('dealId'), str('companyId'), str('subject'));
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export interface ComptableTurn {
  reply: string;
  /** Which tools ran, so the panel can show the working. */
  toolsUsed: Array<{ name: string; input: Record<string, unknown> }>;
  /** Tables and row counts behind the answer. */
  sources: Array<{ table: string; rows: number }>;
}

export function isConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * One turn of conversation, tools and all.
 *
 * A manual loop rather than the SDK tool runner: each tool result has to be
 * inspected on the way past — the panel shows which tables were read and how
 * many rows — and the loop is capped so a confused model cannot bill an
 * unbounded number of calls.
 */
export async function ask(
  history: Anthropic.MessageParam[],
): Promise<ComptableTurn> {
  if (!isConfigured()) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set, so Le Comptable is not available. Every other screen works normally.',
    );
  }

  const client = new Anthropic();
  const messages: Anthropic.MessageParam[] = [...history];
  const toolsUsed: ComptableTurn['toolsUsed'] = [];
  const sources = new Map<string, number>();

  // A finance question needs a handful of lookups, not dozens. The cap is a
  // cost ceiling, not a correctness one.
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
        reply:
          'I stopped on that one. Try asking it a different way, or check the figures on the Finance screen directly.',
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

    // Run them in parallel, then return EVERY result in ONE user message —
    // splitting them teaches the model to stop making parallel calls.
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

          return {
            type: 'tool_result',
            tool_use_id: call.id,
            content: JSON.stringify(result),
          };
        } catch (error) {
          // Hand the failure back rather than dropping it — a missing result
          // makes the model guess, which is the one thing it must not do.
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
    reply:
      'That took more lookups than I allow in one go. Ask it in smaller pieces — one period or one client at a time.',
    toolsUsed,
    sources: [...sources].map(([table, rows]) => ({ table, rows })),
  };
}
