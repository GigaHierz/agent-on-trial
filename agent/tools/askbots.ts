import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { AskbotsClient, projectIdOf, type AskbotsProject } from '../../lib/askbots.js';
import { log } from '../../lib/log.js';
import type { ActContext } from '../context.js';

/**
 * askbots.ai from inside the agent. The challenge is solved by code, not by
 * the model: the window is two seconds and nothing slow may sit between
 * respond and verify.
 */
export function askbotsTools(ctx: ActContext, client: AskbotsClient) {
  let cache: AskbotsProject[] = [];

  const askbots_list_projects = betaZodTool({
    name: 'askbots_list_projects',
    description: 'List the askbots.ai projects open for your review: id, name, property type and URL, and the questions to answer. Empty means no paid work right now.',
    inputSchema: z.object({}),
    run: async () => {
      log.toolCall('askbots_list_projects', {});
      cache = await client.listProjects();
      const out = cache.map((p) => ({
        id: projectIdOf(p),
        name: p.name,
        propertyType: p.propertyType,
        propertyUrl: p.propertyUrl,
        questions: p.questions.map((q) => ({ id: q.id, type: q.type, text: q.text ?? q.question, options: q.options ?? q.choices })),
        evaluationGuidance: p.evaluationGuidance,
      }));
      log.toolResult('askbots_list_projects', `${out.length} project(s)${out[0] ? `: ${out[0].name} ${out[0].propertyUrl}` : ''}`);
      return JSON.stringify(out);
    },
  });

  const askbots_fetch_property = betaZodTool({
    name: 'askbots_fetch_property',
    description: 'Fetch a property URL and return what you can observe: HTTP status, content type, title, headings, address, and the first part of the visible text.',
    inputSchema: z.object({ url: z.string().url() }),
    run: async ({ url }) => {
      log.toolCall('askbots_fetch_property', { url });
      const look = await inspect(url);
      log.toolResult('askbots_fetch_property', `${look.status} ${look.title ?? ''} ${look.bytes}B in ${look.ms}ms`);
      return JSON.stringify(look);
    },
  });

  const askbots_submit_review = betaZodTool({
    name: 'askbots_submit_review',
    description: 'Submit your answers for one project and solve the anti-human challenge. Returns the outcome; when paid, the payout transaction hash.',
    inputSchema: z.object({
      projectId: z.string(),
      answers: z.array(z.object({ questionId: z.string(), answer: z.string().min(1) })).min(1),
    }),
    run: async ({ projectId, answers }) => {
      log.toolCall('askbots_submit_review', { projectId, answers: answers.length });
      const project = cache.find((p) => projectIdOf(p) === projectId);
      const name = project?.name ?? projectId;
      const result = await client.submitReview(projectId, answers);
      if (result.outcome === 'paid') {
        ctx.artifacts.push({ kind: 'askbots_payout', projectId, projectName: name, txHash: result.txHash, payout: result.payout, currency: result.currency });
        log.tx(`askbots paid ${result.payout} ${result.currency}`, result.txHash);
      } else {
        ctx.artifacts.push({ kind: 'askbots_review', projectId, projectName: name, outcome: result.outcome, detail: 'detail' in result ? result.detail : 'reason' in result ? result.reason : undefined });
        log.toolResult('askbots_submit_review', `${result.outcome} ${'detail' in result ? result.detail : 'reason' in result ? result.reason : ''}`);
      }
      return JSON.stringify(result);
    },
  });

  return [askbots_list_projects, askbots_fetch_property, askbots_submit_review];
}

export interface Look {
  url: string;
  status: number;
  ms: number;
  bytes: number;
  contentType?: string;
  title?: string;
  headings: string[];
  address?: string;
  text: string;
  error?: string;
}

/** What a reviewer can say it saw. Plain fetch, no browser. */
export async function inspect(url: string): Promise<Look> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15_000), headers: { 'user-agent': 'agent-on-trial/0.1 (+askbots reviewer)' } });
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const headings = [...html.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 12);
    const address = html.match(/<address[^>]*>([\s\S]*?)<\/address>/i)?.[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      url,
      status: res.status,
      ms: Date.now() - t0,
      bytes: html.length,
      contentType: res.headers.get('content-type') ?? undefined,
      title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1].trim(),
      headings,
      address,
      text: text.slice(0, 2500),
    };
  } catch (err) {
    return { url, status: 0, ms: Date.now() - t0, bytes: 0, headings: [], text: '', error: String(err) };
  }
}
