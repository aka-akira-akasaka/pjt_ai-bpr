/**
 * Phase1 CLI: キャプチャイベントJSONを受け取り、Claudeによる業務分析結果を返す
 *
 * 使い方:
 *   node dist/cli.js <capture_events.json>
 *
 * capture_events.json はExtensionのポップアップからエクスポートしたファイル
 */
import { readFile } from 'fs/promises';
import { callClaude, loadPrompt } from './client.js';

interface CaptureEvent {
  sessionId: string;
  timestamp: number;
  url: string;
  eventType: 'click' | 'input' | 'navigation' | 'copy' | 'paste';
  targetSelector: string;
  value?: string;
}

async function main(): Promise<void> {
  const filePath = process.argv[2];
  if (!filePath) {
    console.error('使い方: node dist/cli.js <capture_events.json>');
    process.exit(1);
  }

  // キャプチャデータを読み込む
  const raw = await readFile(filePath, 'utf-8');
  const events: CaptureEvent[] = JSON.parse(raw);

  if (events.length === 0) {
    console.error('イベントが空です。Extensionで操作を記録してからエクスポートしてください。');
    process.exit(1);
  }

  console.log(`\n📊 ${events.length}件のイベントを分析します...\n`);

  // Claude APIに送るためにイベントを要約形式に変換
  // （生のJSONをそのまま送ると冗長なため、読みやすい形式に変換）
  const summary = summarizeEvents(events);
  const systemPrompt = await loadPrompt('flow_analysis.md');

  const result = await callClaude({
    purpose: 'analyze',
    systemPrompt,
    userMessage: `以下の操作イベントを分析してください:\n\n${summary}`,
  });

  console.log('='.repeat(60));
  console.log('🤖 Claude による業務分析結果');
  console.log('='.repeat(60));
  console.log(result);
  console.log('='.repeat(60));
}

/**
 * イベント配列を人間が読みやすいテキスト形式に変換する
 * プライバシー保護のため、value の内容はすでに匿名化済みであることを前提とする
 */
function summarizeEvents(events: CaptureEvent[]): string {
  const lines: string[] = [];

  // アクセスしたサービス一覧
  const services = [...new Set(events.map(e => e.url))];
  lines.push(`アクセスしたサービス: ${services.join(', ')}`);
  lines.push(`総操作数: ${events.length}件`);
  lines.push('');
  lines.push('## 操作ログ');

  // 時系列順に操作を列挙（最大50件に絞る）
  const sample = events.slice(0, 50);
  for (const event of sample) {
    const time = new Date(event.timestamp).toLocaleTimeString('ja-JP');
    let description: string;

    switch (event.eventType) {
      case 'click':
        description = `クリック: ${event.targetSelector}`;
        break;
      case 'input':
        description = `入力: ${event.targetSelector}（値: ${event.value ?? ''}）`;
        break;
      case 'navigation':
        description = `画面遷移: ${event.url}`;
        break;
      case 'copy':
        description = `コピー: ${event.targetSelector}`;
        break;
      case 'paste':
        description = `ペースト: ${event.targetSelector}`;
        break;
    }

    lines.push(`[${time}] ${event.url} - ${description}`);
  }

  if (events.length > 50) {
    lines.push(`... (${events.length - 50}件省略)`);
  }

  return lines.join('\n');
}

main().catch((err: unknown) => {
  console.error('エラーが発生しました:', err);
  process.exit(1);
});
