import type { ClusterNode, LLMConfig, MindmapState, TreeNode } from './types.js';

const PROVIDER_URLS: Record<string, string> = {
  openrouter: 'https://openrouter.ai/api/v1/chat/completions',
  openai: 'https://api.openai.com/v1/chat/completions',
};

const DEFAULT_MODELS: Record<string, string> = {
  openrouter: 'google/gemini-2.0-flash-001',
  openai: 'gpt-4o-mini',
};

function collectContent(node: ClusterNode): string[] {
  const contents: string[] = [];
  for (const item of node.items) {
    contents.push(`[${item.role}]: ${item.content}`);
  }
  for (const child of node.children) {
    contents.push(...collectContent(child));
  }
  return contents;
}

async function generateTreeFromLLM(
  state: MindmapState,
  config: LLMConfig,
): Promise<TreeNode> {
  const contents = collectContent(state.root);

  if (contents.length === 0) {
    return { label: 'Knowledge', children: [] };
  }

  const prompt = `Analyze the following conversation snippets and organize them into a hierarchical mindmap tree.
Group related topics together. Each node should have a short, descriptive label (2-5 words).

Conversation snippets:
${contents.map((c, i) => `${i + 1}. ${c}`).join('\n')}

Respond with ONLY valid JSON in this exact format (no markdown, no code fences):
{
  "label": "root label",
  "children": [
    {
      "label": "topic label",
      "children": [
        { "label": "subtopic label", "children": [] }
      ]
    }
  ]
}`;

  const url = PROVIDER_URLS[config.provider];
  const model = config.model ?? DEFAULT_MODELS[config.provider];

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '(no body)');
    throw new Error(`LLM tree generation failed: ${resp.status} ${errBody}`);
  }

  const json = (await resp.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const raw = json.choices[0]?.message?.content ?? '';
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

  try {
    return JSON.parse(cleaned) as TreeNode;
  } catch {
    // Fallback to cluster-based tree if LLM output is unparseable
    return clusterToTree(state.root, false);
  }
}

function clusterToTree(node: ClusterNode, detailed: boolean): TreeNode {
  const tree: TreeNode = {
    label: node.label,
    children: node.children.map((c) => clusterToTree(c, detailed)),
  };

  if (detailed) {
    tree.items = node.items.map(({ id, role, content, timestamp }) => ({
      id,
      role,
      content,
      ...(timestamp ? { timestamp } : {}),
    }));
    tree.depth = node.depth;
    tree.itemCount = node.itemCount;
  }

  return tree;
}

export function toTree(state: MindmapState, options?: { detailed?: boolean }): TreeNode {
  return clusterToTree(state.root, options?.detailed ?? false);
}

export async function toTreeLLM(
  state: MindmapState,
  config: LLMConfig,
): Promise<TreeNode> {
  return generateTreeFromLLM(state, config);
}
