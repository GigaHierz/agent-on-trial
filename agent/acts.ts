import { USEBUY_URL } from '@trial/shared';

export type ActName = 'earn' | 'spend' | 'dispute';

export interface ActSpec {
  name: ActName;
  /** Tool names the model may call in this act. */
  tools: string[];
  task: (p: { shadyUrl?: string; shadyAgentId?: string; propertyUrl?: string }) => string;
}

const MEMORY = ['memory_read', 'memory_write'];

/** What the room reads as the host's question when an act runs, from the session or as a script. */
export const ACT_PROMPTS: Record<string, string> = {
  identity: 'Who are you? Register on askbots.ai and get your ERC-8004 identity.',
  earn: 'Find work on askbots.ai and get paid.',
  spend: 'Buy something useful for your business on usebuy.ai.',
  dispute: 'Buy the market report from the new provider.',
  verdict: 'The jury has voted. Read the verdict.',
};

/**
 * What the host asks for, as the model sees it. The session also accepts free
 * text; these are the scripted versions the non-interactive act scripts use.
 */
export const ACTS: Record<ActName, ActSpec> = {
  earn: {
    name: 'earn',
    tools: ['askbots_list_projects', 'askbots_fetch_property', 'askbots_submit_review', ...MEMORY],
    task: () =>
      [
        'Find paid work on askbots.ai and get paid.',
        'List the open projects. Pick the first one. Fetch its property URL and read it.',
        'Answer every question with concrete observations from the page. For yes/no or choice questions, answer with one of the allowed options. For free-text questions, write 2-4 sentences that name specific things you saw.',
        'Submit the review. The submit tool solves the anti-human challenge for you. Report the outcome and the payout transaction hash.',
        'Then write a memory entry.',
      ].join('\n'),
  },
  spend: {
    name: 'spend',
    tools: ['buy_whoami', 'buy_balance', 'buy_discover', 'buy_pay_quote', 'buy_curl', 'check_reputation', ...MEMORY],
    task: ({ propertyUrl }) =>
      [
        `You are a reviewer business now. Buy data that makes your reviews better, with the money you earned. The marketplace is ${USEBUY_URL}.`,
        'Check your balance first. Then use buy_discover to find the buy API gateway (buy/api-gateway) and fetch its free catalog with buy_curl (GET https://gateway.usebuy.ai/v1/catalog; it costs nothing).',
        'Pick one X (Twitter) endpoint from the catalog that tells you how a business is talked about or how active it is on X, for example a post search or a user profile lookup, and that costs 0.05 USD₮ or less. Use it to check the marketing of the business you reviewed' +
          (propertyUrl ? ` (the property at ${propertyUrl})` : '') +
          ': search for its name or a close match.',
        'Get a quote with buy_pay_quote (POST, the exact JSON body as a string, token USDT). If the quote is 0.05 USD₮ or less, pay with buy_curl with the same URL, method and body, token USDT. Report the settlement transaction hash from the response and one sentence on what the data says about the marketing.',
        'Then write a memory entry.',
      ].join('\n'),
  },
  dispute: {
    name: 'dispute',
    tools: ['check_reputation', 'buy_pay_quote', 'buy_curl', 'open_dispute', ...MEMORY],
    task: ({ shadyUrl, shadyAgentId }) =>
      [
        `A provider sells a Celo market report at ${shadyUrl ?? 'http://localhost:4402/report/celo'}. Its ERC-8004 agent id is ${shadyAgentId ?? 'unknown'}.`,
        'The advertised spec is: "a Celo market report with sections: price, volume, sources".',
        'Check the provider\'s reputation first and say what you found. Get a quote (token USDT). If it is 0.05 USD₮ or less, buy it (token USDT).',
        'Read what came back. Compare it to the spec. If any section is missing, open a dispute with the receipt, the spec, the delivered body verbatim, and a one-paragraph claim.',
        'Then write a memory entry.',
      ].join('\n'),
  },
};
