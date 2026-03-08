import Anthropic from '@anthropic-ai/sdk';

// ai-engineにおけるClaude APIの唯一の入口
// モデルの使い分けはここで一元管理する

const client = new Anthropic({
  // ANTHROPIC_API_KEY 環境変数を自動参照
});

// 目的別モデル定義
export const MODELS = {
  // 「読む・理解する・調べる」タスク → Sonnet
  analyze: 'claude-sonnet-4-6' as const,
  // 「書く・生成する」タスク → Opus
  generate: 'claude-opus-4-6' as const,
} as const;

export type ModelPurpose = keyof typeof MODELS;

/**
 * システムプロンプトをファイルから読み込む
 * Phase1では簡略化のためインライン定義も可
 */
export async function loadPrompt(name: string): Promise<string> {
  const { readFile } = await import('fs/promises');
  const { join, dirname } = await import('path');
  const { fileURLToPath } = await import('url');
  const dir = dirname(fileURLToPath(import.meta.url));
  return readFile(join(dir, 'prompts', name), 'utf-8');
}

/**
 * Claude APIを呼び出す共通関数
 * ストリーミングを使用してタイムアウトを防止する
 */
export async function callClaude(params: {
  purpose: ModelPurpose;
  systemPrompt: string;
  userMessage: string;
}): Promise<string> {
  const model = MODELS[params.purpose];

  const stream = client.messages.stream({
    model,
    max_tokens: 4096,
    thinking: { type: 'adaptive' },
    system: params.systemPrompt,
    messages: [{ role: 'user', content: params.userMessage }],
  });

  const response = await stream.finalMessage();

  // テキストブロックを結合して返す
  const textParts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') {
      textParts.push(block.text);
    }
  }
  return textParts.join('');
}

export { client };
