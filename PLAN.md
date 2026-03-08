# pjt_ai-bpr 実装計画

最終更新: 2026-03-08

---

## 1. プロジェクト全体像

### パイプライン概要

```
[画面/操作] → watcher → analyzer → ai-engine → dashboard（承認） → automation → [実行結果]
                  ↑                                                        ↓
                  └──────────────── フィードバックループ ──────────────────┘
```

### 設計原則

- ユーザーは何も操作しない。バックグラウンドで自律的に動く
- 破壊的操作は必ずユーザー承認を経由する（automation のドライラン原則）
- 各モジュールは疎結合。イベントバスを通じてのみ通信する
- セキュリティファースト: 画面データはメモリ上のみ、外部送信前に必ず匿名化

---

## 2. 技術選定

### 言語・ランタイムの使い分け

| モジュール | 言語 | 理由 |
|---|---|---|
| watcher | Node.js (TypeScript) | Electronとの親和性、OS APIへのバインディングが充実 |
| analyzer | Python | NumPy/PIL による画像処理、scikit-learn によるパターン分析 |
| ai-engine | Node.js (TypeScript) | Claude API SDK が TypeScript ファースト、型安全なプロンプト管理 |
| automation | Node.js (TypeScript) | Playwright が TypeScript ネイティブ |
| dashboard | Node.js (TypeScript) + React | Electron レンダラーと統合、リアルタイム更新に適合 |

### モジュール間通信

- watcher → analyzer: gRPC（バイナリ画像データの効率的転送）
- analyzer → ai-engine: JSON over Unix Socket（同一ホスト前提）
- ai-engine → dashboard: WebSocket（リアルタイム提案通知）
- dashboard → automation: REST API（承認イベントのトリガー）

### 主要依存パッケージ

| パッケージ | 用途 |
|---|---|
| `@anthropic-ai/sdk` | Claude API クライアント |
| `playwright` | ブラウザ自動化 |
| `electron` | デスクトップアプリ基盤 |
| `sharp` | 画像差分検出・前処理 |
| `grpc-js` | watcher-analyzer 間通信 |
| `socket.io` | dashboard リアルタイム通信 |

---

## 3. モジュール責務・インターフェース設計

### 3.1 watcher（Node.js / TypeScript）

**責務**: 画面キャプチャとユーザー操作ログの収集

**ディレクトリ構成**

```
watcher/
├── index.ts              # エントリポイント、キャプチャループ管理
├── capture/
│   ├── screen.ts         # OS ネイティブスクリーンショット
│   └── diff.ts           # フレーム差分検出（変化なしはスキップ）
├── events/
│   ├── mouse.ts          # マウス操作ログ
│   └── keyboard.ts       # キーボード操作ログ（パスワード除外付き）
├── privacy/
│   └── filter.ts         # 機密フィールド除外ロジック
└── transport/
    └── grpc-client.ts    # analyzer への送信
```

**公開インターフェース**

```typescript
interface CaptureEvent {
  timestamp: number;
  type: 'screenshot' | 'mouse' | 'keyboard';
  payload: ScreenshotPayload | MousePayload | KeyboardPayload;
  sessionId: string;  // ユーザー識別子は含まない
}

interface ScreenshotPayload {
  imageBuffer: Buffer;  // PNG バイナリ（ディスクに書かない）
  activeWindow: string;
  diff: number;         // 前フレームからの差分率 0.0-1.0
}
```

**セキュリティ制約**

- `filter.ts` でパスワードマネージャー・銀行サイト・input[type=password] の領域をブラックアウト
- キャプチャ間隔: デフォルト 500ms（設定可変）
- 差分率 5% 未満のフレームは送信しない

---

### 3.2 analyzer（Python）

**責務**: キャプチャイベントから業務パターンを抽出しフローを構造化

**ディレクトリ構成**

```
analyzer/
├── main.py               # gRPC サーバー、イベント受信
├── vision/
│   ├── ocr.py            # 画面テキスト抽出（Tesseract / Vision API）
│   └── ui_detector.py    # ボタン・フォーム・テーブル検出
├── patterns/
│   ├── sequence.py       # 操作シーケンスのパターンマイニング
│   └── flow_extractor.py # 繰り返し業務フローの抽出
├── anonymizer.py         # 個人情報・機密情報のマスキング
└── schema/
    └── flow.py           # BusinessFlow データクラス
```

**公開インターフェース（出力スキーマ）**

```python
@dataclass
class BusinessFlow:
    flow_id: str
    name: str                      # 例: "受注データをExcelに転記"
    frequency: int                 # 検出された繰り返し回数
    steps: list[FlowStep]
    estimated_time_per_run: float  # 秒
    confidence: float              # 0.0-1.0

@dataclass
class FlowStep:
    order: int
    action_type: str               # "click" | "type" | "navigate" | "copy_paste"
    target_app: str                # "Excel" | "Chrome" | "Outlook" など
    description: str               # 匿名化済みの操作説明
```

**処理フロー**

1. OCR でテキスト抽出 → anonymizer で個人情報マスク
2. 操作シーケンスをスライディングウィンドウでパターンマイニング
3. 繰り返し頻度 3 回以上を BusinessFlow 候補として抽出
4. confidence スコアと共に ai-engine へ送信

---

### 3.3 ai-engine（Node.js / TypeScript）

**責務**: BusinessFlow を受け取り、AI 化・自動化の提案を生成する

**ディレクトリ構成**

```
ai-engine/
├── client.ts             # Claude API の唯一の窓口（全モジュールここを経由）
├── proposer.ts           # BusinessFlow → AutomationProposal の変換
├── prompts/
│   ├── flow_analysis.md  # フロー分析プロンプト（sonnet-4-6 用）
│   └── code_generation.md # 自動化コード生成プロンプト（opus-4-6 用）
└── schema/
    └── proposal.ts       # AutomationProposal 型定義
```

**公開インターフェース**

```typescript
interface AutomationProposal {
  proposalId: string;
  sourceFlowId: string;
  title: string;
  description: string;
  estimatedTimeSaving: number;  // 週あたり節約時間（分）
  automationType: 'playwright' | 'api_integration' | 'macro';
  draftCode: string;            // Playwright スクリプト等
  risks: string[];              // リスク一覧
  status: 'pending_approval' | 'approved' | 'rejected' | 'executing';
}
```

**Claude API モデル使い分け**

- `client.ts` で `purpose` パラメータを受け取り自動切替
- `purpose: 'analyze'` → `claude-sonnet-4-6`（BusinessFlow 全体把握）
- `purpose: 'generate'` → `claude-opus-4-6`（自動化コード生成）

**セキュリティ**

- `client.ts` 内で送信前に `anonymizer` を通す
- システムプロンプトは `prompts/` の .md ファイルから読み込み（ハードコード禁止）

---

### 3.4 automation（Node.js / TypeScript）

**責務**: 承認済み AutomationProposal の実行

**ディレクトリ構成**

```
automation/
├── executor.ts           # 提案を受け取り実行管理
├── runners/
│   ├── playwright.ts     # Playwright ブラウザ自動化
│   └── os_action.ts      # キーボード・クリップボード操作
├── sandbox/
│   └── dry_run.ts        # ドライラン（実際の副作用なし）
└── audit_log.ts          # 実行ログ（暗号化保存）
```

**実行原則**

1. 必ず dry_run を先行実行し、想定外の操作がないか確認
2. 破壊的操作（POST/DELETE/ファイル送信）はダッシュボードで再確認
3. audit_log に操作内容・日時・成否を記録（平文禁止、AES-256）

---

### 3.5 dashboard（React + Electron）

**責務**: 提案の承認UI・実行状況の可視化

**ディレクトリ構成**

```
dashboard/
├── electron/
│   └── main.ts           # Electron メインプロセス
├── src/
│   ├── App.tsx
│   ├── pages/
│   │   ├── Proposals.tsx  # 承認待ち提案一覧
│   │   ├── FlowViewer.tsx # 検出された業務フロー可視化
│   │   └── AuditLog.tsx   # 実行履歴
│   └── api/
│       └── socket.ts      # WebSocket 接続（ai-engine から受信）
└── package.json
```

---

## 4. データフロー設計

```
watcher
  └─[gRPC: CaptureEvent]─→ analyzer
                               └─[Unix Socket: BusinessFlow]─→ ai-engine
                                                                   └─[WebSocket: AutomationProposal]─→ dashboard
                                                                                                           └─[REST: approved ProposalId]─→ automation
                                                                                                                                               └─[audit log]
```

### イベントバスの代替案（将来検討）

- 現状: 直接 gRPC / Socket 通信（シンプルさ優先）
- 将来: Redis Streams or NATS JetStream（スケールアウト時）

---

## 5. セキュリティ・プライバシー設計

### データ分類と処理ルール

| データ種別 | 保存 | 外部送信 | 処理場所 |
|---|---|---|---|
| スクリーンショット | 禁止（メモリのみ） | 匿名化後のみ | watcher → analyzer |
| 操作ログ（テキスト） | 暗号化のみ | 匿名化後のみ | watcher |
| 抽出業務フロー | 可（匿名化済み） | 可（匿名化済み） | analyzer |
| 自動化コード | 可 | AI API のみ | ai-engine |
| 実行ログ | AES-256 暗号化 | 不可 | automation |

### 匿名化処理の対象

- 氏名・メールアドレス・電話番号 → `[PERSON]` `[EMAIL]` `[PHONE]` に置換
- URLのクエリパラメータ → `?[MASKED]` に置換
- パスワード入力フィールド → キャプチャ対象から除外

### 実装で必ず入れるガードレール

- `watcher/privacy/filter.ts`: キャプチャ前フィルタ
- `analyzer/anonymizer.py`: テキスト抽出後の即時マスキング
- `ai-engine/client.ts`: Claude API 送信直前の最終確認

---

## 6. 実装ロードマップ

### Phase 1: MVP（2週間）

**目標**: watcher → analyzer → ai-engine の最小パイプラインを手動トリガーで動作させる

| タスク | モジュール | 優先度 |
|---|---|---|
| スクリーンショット取得（1枚） | watcher | 高 |
| OCR でテキスト抽出 | analyzer | 高 |
| 抽出テキストを Claude に送り業務説明を生成 | ai-engine | 高 |
| CLI で結果確認できる | - | 高 |
| 差分検出によるフレームスキップ | watcher | 中 |
| 匿名化処理（基本） | analyzer | 高 |

**MVP の成功基準**

- 任意の画面キャプチャから「この画面で何をしているか」の説明が自動生成される
- 個人情報が Claude に送信されていないことが確認できる

---

### Phase 2: パターン検出（2週間）

**目標**: 繰り返し操作から BusinessFlow を自動抽出する

| タスク | モジュール |
|---|---|
| 操作シーケンスのロギング | watcher |
| パターンマイニング実装 | analyzer |
| BusinessFlow スキーマの確定 | analyzer |
| ai-engine への BusinessFlow 送信 | analyzer |
| AutomationProposal の生成 | ai-engine |

---

### Phase 3: 承認フロー・実行（2週間）

**目標**: ダッシュボードで提案を承認し、Playwright で自動実行する

| タスク | モジュール |
|---|---|
| dashboard の基本 UI | dashboard |
| WebSocket で提案をリアルタイム表示 | dashboard, ai-engine |
| 承認 → automation へのトリガー | dashboard, automation |
| Playwright ドライラン実装 | automation |
| audit_log 実装 | automation |

---

### Phase 4: 品質・セキュリティ強化（継続）

- E2E テストのサンドボックス化
- 暗号化ログの実装
- UI の改善とフィードバックループ

---

## 7. 開発の始め方

### 最初に作るファイル（Phase 1 開始順）

1. `watcher/capture/screen.ts` - OS スクリーンショット取得
2. `watcher/privacy/filter.ts` - 機密フィールド除外
3. `analyzer/vision/ocr.py` - Tesseract OCR 呼び出し
4. `analyzer/anonymizer.py` - 個人情報マスキング
5. `ai-engine/client.ts` - Claude API クライアント（全 API コールの唯一の入口）
6. `ai-engine/prompts/flow_analysis.md` - 分析プロンプト

### パッケージ初期化コマンド

```bash
# watcher, ai-engine, automation, dashboard
cd watcher && npm init -y && npm install typescript @types/node

# analyzer
cd analyzer && python -m venv .venv && pip install pytesseract Pillow grpcio

# ai-engine
cd ai-engine && npm install @anthropic-ai/sdk
```

---

## 8. 未解決の技術的判断事項

以下は実装開始前に決定が必要な事項:

1. **OCR エンジン選定**: Tesseract（ローカル・無料）vs Google Vision API（高精度・有料）
   - 推奨: Phase 1 は Tesseract で始め、精度不足であれば Vision API に切替
2. **Electron vs ブラウザ拡張機能**: 全画面監視が必要なため Electron が第一候補
3. **gRPC の採用判断**: Phase 1 は単純な HTTP/JSON でも可。画像データ量が増えてから gRPC に移行する選択肢もある
