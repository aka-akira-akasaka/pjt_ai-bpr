# pjt_ai-bpr 実装計画（SaaS版）

最終更新: 2026-03-08

---

## 1. プロダクト概要・SaaS方針

### 核心的な価値

ユーザーは何も操作しない。Chrome拡張機能をインストールするだけで、
業務がバックグラウンドで分析され、自動化提案が届き、承認するだけで自動化される。

### 初期ターゲット

- **対象業務**: Webブラウザ（Chrome）上で行われるすべての業務
- **典型的なユースケース**: SalesforceへのデータCopy&Paste、スプレッドシートとWebツール間の転記、フォーム入力の繰り返し作業
- **ターゲット顧客**: SaaSツールを多用している中小〜中堅企業

### 課金モデル

- **自動化実行数ベース**: 1実行 = 1カウント（月次集計、超過従量制）
- プラン例: Starter（100回/月）/ Growth（1,000回/月）/ Enterprise（無制限＋SLA）

---

## 2. アーキテクチャ全体像

### コンポーネント構成

```
【顧客側】
Chrome Extension（watcher + executor）
  │  ① 操作イベントを匿名化して送信（HTTPS）
  │  ④ 承認済みスクリプトを受信してローカル実行
  ▼
【クラウド側（マルチテナントSaaS）】
┌─────────────────────────────────────────┐
│  API Gateway（認証・レート制限・テナントルーティング）  │
├──────────────┬──────────────┬───────────┤
│  analyzer    │  ai-engine   │ automation│
│  (Python)    │  (Node.js)   │ (Node.js) │
│  パターン分析 │  Claude API  │スクリプト生成│
│  フロー抽出  │  提案生成    │           │
├──────────────┴──────────────┴───────────┤
│  dashboard（React Web App）              │
│  ② フロー・提案の可視化  ③ 承認操作      │
├─────────────────────────────────────────┤
│  データ層（PostgreSQL + Row Level Security）│
│  ストレージ（S3 / GCS、テナント別暗号化）  │
│  キュー（SQS / Cloud Tasks）             │
└─────────────────────────────────────────┘
```

### データフロー

```
Extension（操作キャプチャ）
  └─[HTTPS: CaptureEvent]─→ API Gateway
                               └─[Queue]─→ analyzer
                                              └─[Unix Socket]─→ ai-engine
                                                                   └─[WebSocket]─→ dashboard（承認待ち）
                                                                                       └─[承認]─→ automation
                                                                                                    └─[WebSocket]─→ Extension（スクリプト実行）
                                                                                                                       └─[実行結果]─→ API Gateway（課金カウント）
```

### Extensionがexecutorを兼ねる理由

- 顧客の認証済みChromeセッションをそのまま利用できる
- SaaSツール（Salesforce・Notion・Googleなど）へのログイン情報をクラウドに保存しなくて済む
- Extension内でスクリプトを実行するため、企業のセキュリティポリシーに適合しやすい

---

## 3. マルチテナント設計

### テナント分離戦略

| レイヤー | 分離方式 | 理由 |
|---|---|---|
| DB | Row Level Security（テナントID列） | コスト効率とセキュリティのバランス |
| ストレージ | テナントIDプレフィックス + 個別KMS鍵 | データが混在しない |
| AI API呼び出し | テナント別使用量追跡 | 課金計算・レート制限に使用 |
| キュー | テナント別キュー（大口）or メタデータフィルタ（小口） | 大口顧客の処理優先度確保 |

### テナントデータモデル

```sql
-- すべてのテーブルに tenant_id を持ち RLS で分離
CREATE TABLE tenants (
  id          UUID PRIMARY KEY,
  name        TEXT NOT NULL,
  plan        TEXT NOT NULL,  -- 'starter' | 'growth' | 'enterprise'
  created_at  TIMESTAMPTZ
);

CREATE TABLE users (
  id          UUID PRIMARY KEY,
  tenant_id   UUID REFERENCES tenants(id),
  email       TEXT NOT NULL,
  role        TEXT NOT NULL   -- 'admin' | 'member' | 'viewer'
);

CREATE TABLE business_flows (
  id              UUID PRIMARY KEY,
  tenant_id       UUID REFERENCES tenants(id),
  name            TEXT,
  frequency       INT,
  confidence      FLOAT,
  created_at      TIMESTAMPTZ
);

CREATE TABLE automation_proposals (
  id                UUID PRIMARY KEY,
  tenant_id         UUID REFERENCES tenants(id),
  flow_id           UUID REFERENCES business_flows(id),
  title             TEXT,
  draft_script      TEXT,   -- 暗号化保存
  status            TEXT,   -- 'pending' | 'approved' | 'rejected' | 'executing'
  approved_by       UUID REFERENCES users(id),
  approved_at       TIMESTAMPTZ
);

CREATE TABLE execution_logs (
  id              UUID PRIMARY KEY,
  tenant_id       UUID REFERENCES tenants(id),
  proposal_id     UUID REFERENCES automation_proposals(id),
  executed_at     TIMESTAMPTZ,
  success         BOOLEAN,
  duration_ms     INT
);

-- Row Level Security 設定例
ALTER TABLE business_flows ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON business_flows
  USING (tenant_id = current_setting('app.tenant_id')::UUID);
```

### 使用量計測・課金

```
execution_logs テーブル → 月次集計 → billing_usage テーブル
                                            └─→ Stripe API（請求）
```

---

## 4. モジュール設計

### 4.1 Chrome Extension（watcher + executor）

**責務**: 操作イベントのキャプチャ / 承認済みスクリプトのローカル実行

**構成**

```
extension/
├── manifest.json         # Chrome Extension Manifest V3
├── background/
│   ├── service-worker.ts # イベント送信・WebSocket接続管理
│   └── api-client.ts     # クラウドAPIとの通信
├── content/
│   ├── watcher.ts        # DOM操作イベントの収集
│   ├── privacy-filter.ts # 機密フィールド除外（input[type=password]等）
│   └── executor.ts       # 承認済みスクリプトの実行エンジン
├── popup/
│   └── App.tsx           # ステータス確認・ON/OFFトグル
└── utils/
    └── anonymizer.ts     # 個人情報マスキング（送信前）
```

**キャプチャするイベント**

```typescript
interface CaptureEvent {
  sessionId: string;       // テナントID + ランダムセッションID
  timestamp: number;
  url: string;             // originのみ（パス・クエリはマスク）
  eventType: 'click' | 'input' | 'navigation' | 'copy' | 'paste';
  targetSelector: string;  // DOMセレクタ（個人情報除外済み）
  value?: string;          // input値（匿名化済み）
}
```

**スクリプト実行（executor）**

- クラウドから受け取るのは「Playwright互換のDOM操作命令リスト（JSON）」
- Extensionが `chrome.debugger` API を使用してChrome DevTools Protocolで実行
- 実行前に必ずダイアログで「何をするか」をユーザーに表示し確認

**セキュリティ**

- `privacy-filter.ts` でパスワードフィールド・クレカ番号フィールドをキャプチャ除外
- URLはoriginのみ送信（`https://app.salesforce.com` のように）
- スクリプト実行は承認済みのプロポーザルIDとHMACで署名確認

---

### 4.2 API Gateway / Backend（Node.js / TypeScript）

**責務**: 認証・テナントルーティング・レート制限・WebSocket管理

**構成**

```
backend/
├── index.ts
├── auth/
│   ├── jwt.ts            # JWT検証（Auth0 / Supabase Auth）
│   └── tenant.ts         # テナントコンテキストの解決
├── routes/
│   ├── events.ts         # POST /events（Extensionからの受信）
│   ├── proposals.ts      # GET/PATCH /proposals（ダッシュボード用）
│   ├── executions.ts     # POST /executions（実行トリガー）
│   └── billing.ts        # GET /usage（使用量確認）
├── ws/
│   └── gateway.ts        # WebSocket（リアルタイム提案通知・実行指示）
├── queue/
│   └── publisher.ts      # SQS/Cloud Tasks へのエンキュー
└── middleware/
    ├── rate-limit.ts     # テナント別レート制限
    └── usage-meter.ts    # 実行カウント記録
```

**APIエンドポイント設計**

```
POST   /api/v1/events              # Extension → イベント送信
GET    /api/v1/flows               # ダッシュボード → フロー一覧
GET    /api/v1/proposals           # ダッシュボード → 提案一覧
PATCH  /api/v1/proposals/:id       # ダッシュボード → 承認/却下
POST   /api/v1/proposals/:id/execute # 実行トリガー
GET    /api/v1/usage               # 使用量確認
WS     /ws                         # リアルタイム通知
```

---

### 4.3 analyzer（Python）

**責務**: キャプチャイベントから繰り返し業務フローを抽出

**構成**

```
analyzer/
├── main.py               # Workerプロセス（キューから消費）
├── patterns/
│   ├── sequence.py       # スライディングウィンドウでパターンマイニング
│   └── flow_extractor.py # 繰り返し3回以上をBusinessFlow候補に
├── schema/
│   └── flow.py           # BusinessFlowデータクラス
└── anonymizer.py         # 2次匿名化（念のため二重チェック）
```

**出力スキーマ**

```python
@dataclass
class BusinessFlow:
    flow_id: str
    tenant_id: str
    name: str                      # 例: "Salesforceの商談データをスプレッドシートに転記"
    frequency: int                 # 検出した繰り返し回数
    steps: list[FlowStep]
    target_services: list[str]     # ["salesforce.com", "docs.google.com"]
    estimated_time_per_run: float  # 秒
    confidence: float              # 0.0-1.0

@dataclass
class FlowStep:
    order: int
    action_type: str               # "click" | "input" | "copy" | "paste" | "navigate"
    service: str                   # "salesforce.com"
    description: str               # 匿名化済みの説明
    selector_hint: str             # DOM操作のヒント情報
```

---

### 4.4 ai-engine（Node.js / TypeScript）

**責務**: BusinessFlowを受け取り、自動化提案とChrome操作スクリプトを生成

**構成**

```
ai-engine/
├── client.ts             # Claude API 唯一の入口（モデル自動切替）
├── proposer.ts           # BusinessFlow → AutomationProposal 変換
├── script-generator.ts  # 自動化スクリプト（CDP命令JSON）生成
├── prompts/
│   ├── flow_analysis.md  # sonnet-4-6用: フロー分析・提案生成
│   └── script_gen.md     # opus-4-6用: Chrome操作スクリプト生成
└── schema/
    └── proposal.ts
```

**AutomationProposalスキーマ**

```typescript
interface AutomationProposal {
  proposalId: string;
  tenantId: string;
  sourceFlowId: string;
  title: string;
  description: string;
  estimatedTimeSaving: number;  // 週あたり節約時間（分）
  targetServices: string[];     // ["salesforce.com", "docs.google.com"]
  script: CDPScript;            // Chrome操作命令リスト
  risks: string[];
  status: 'pending_approval' | 'approved' | 'rejected' | 'executing';
}

// Extensionのexecutorが解釈するChrome操作命令
interface CDPScript {
  version: string;
  steps: CDPStep[];
}

interface CDPStep {
  action: 'navigate' | 'click' | 'type' | 'wait' | 'extract' | 'assert';
  selector?: string;
  value?: string;
  url?: string;
  description: string;  // ユーザーへの説明（確認ダイアログ表示用）
}
```

**Claude API モデル使い分け**

| purpose | モデル | 用途 |
|---|---|---|
| `'analyze'` | `claude-sonnet-4-6` | フロー全体把握・提案タイトル・リスク抽出 |
| `'generate'` | `claude-opus-4-6` | CDPスクリプト生成（高精度コード生成が必要）|

---

### 4.5 dashboard（React Web App）

**責務**: 提案の承認UI、実行状況の可視化、使用量・課金確認

**構成**

```
dashboard/
├── src/
│   ├── App.tsx
│   ├── pages/
│   │   ├── Proposals.tsx    # 承認待ち提案一覧（メイン画面）
│   │   ├── FlowViewer.tsx   # 検出された業務フロー一覧・詳細
│   │   ├── ExecutionLog.tsx # 実行履歴・成功率
│   │   └── Usage.tsx        # 使用量・課金状況
│   ├── components/
│   │   ├── ProposalCard.tsx  # 提案カード（承認/却下ボタン付き）
│   │   └── ScriptPreview.tsx # 実行されるスクリプトの可読プレビュー
│   └── hooks/
│       └── useWebSocket.ts  # リアルタイム提案通知
└── package.json
```

---

## 5. セキュリティ・プライバシー設計

### データ分類と処理ルール

| データ種別 | 処理場所 | 保存 | 外部送信 |
|---|---|---|---|
| 生の画面内容・入力値 | Extensionのみ（クラウド送信禁止） | 禁止 | 禁止 |
| 匿名化済み操作イベント | Extension → Cloud | DBに保存（テナント別暗号化） | Claudeに送信可 |
| 抽出業務フロー | Cloud | DB（匿名化済み） | Claude API |
| 自動化スクリプト | Cloud生成 → Extension実行 | DB（暗号化） | Extension |
| 実行ログ | Cloud | DB（暗号化） | 不可 |

### 匿名化処理（Extension側）

- パスワード・クレカ番号フィールド → キャプチャ除外
- URLクエリパラメータ → `?[MASKED]` に置換
- 入力値（テキスト） → カテゴリタグに変換（例: "田中太郎" → `[PERSON_NAME]`）
- URLはoriginのみ（`https://app.salesforce.com`）

### スクリプト実行のセキュリティ

- クラウドから受け取るスクリプトは `proposalId + tenantId` のHMACで署名検証
- 実行前に必ず確認ダイアログ（何をするか可読テキストで表示）
- 外部ドメインへの予期しないnavigate命令は自動ブロック

---

## 6. インフラ設計

### 推奨構成（初期〜中期）

```
Vercel / Railway
├── backend（Node.js）    ← API Gateway + WebSocket
├── analyzer（Python）    ← Worker
├── ai-engine（Node.js）  ← Worker
└── dashboard（React）    ← Static

Supabase
├── PostgreSQL + RLS
└── Auth（JWT発行）

AWS SQS / Google Cloud Tasks
└── 非同期ジョブキュー

Stripe
└── 課金・使用量管理
```

### スケールアップ時の移行先

- コンテナオーケストレーション: Kubernetes（GKE/EKS）
- キュー: NATS JetStream（より高スループット）
- ストレージ: S3 + テナント別KMSキー

---

## 7. 実装ロードマップ

### Phase 1: ローカル検証MVP（2週間）

**目標**: Chrome ExtensionでChromeの操作を収集 → Claudeが業務説明を返す

| タスク | 担当モジュール |
|---|---|
| Chrome Extension（Manifest V3）の骨格作成 | extension |
| DOM操作イベントのキャプチャ（click/input） | extension/content/watcher.ts |
| 匿名化フィルター（パスワード除外・URL加工） | extension/utils/anonymizer.ts |
| Claude APIクライアント（client.ts）実装 | ai-engine |
| キャプチャデータを送りClaude解説を返すCLI | ai-engine |

**成功基準**: ExtensionをインストールしたChromeでSalesforceを操作すると、「この操作の説明」が返ってくる

---

### Phase 2: クラウドバックエンド + パターン検出（3週間）

**目標**: マルチテナントAPIを立て、繰り返し操作からBusinessFlowを自動抽出する

| タスク | 担当モジュール |
|---|---|
| Supabase（PostgreSQL + Auth）セットアップ | infra |
| テナントデータモデルの実装（RLS設定） | infra |
| API Gateway実装（認証・イベント受信） | backend |
| パターンマイニング実装 | analyzer |
| BusinessFlow → AutomationProposal生成 | ai-engine |
| Extensionをクラウド接続に対応 | extension |

---

### Phase 3: 承認フロー + スクリプト実行（2週間）

**目標**: ダッシュボードで提案を承認し、Extensionがスクリプトを実行する

| タスク | 担当モジュール |
|---|---|
| CDPスクリプト生成プロンプト実装 | ai-engine |
| Extension executor実装（CDPスクリプト実行） | extension/content/executor.ts |
| 実行前確認ダイアログ実装 | extension |
| dashboard基本UI（提案一覧・承認ボタン） | dashboard |
| WebSocketリアルタイム通知 | backend, dashboard |
| 実行ログ記録 | backend |

---

### Phase 4: 課金・マーケット投入（2週間）

**目標**: 課金フローを完成させ、Chrome Web Storeに公開できる状態にする

| タスク | 担当モジュール |
|---|---|
| Stripe連携（使用量ベース課金） | backend/billing |
| 使用量ダッシュボード | dashboard/Usage.tsx |
| テナントオンボーディングフロー | dashboard, backend |
| Chrome Web Storeへの申請準備 | extension |
| セキュリティ監査・ペネトレーションテスト | 全体 |

---

## 8. 技術的判断事項（未確定）

| 事項 | 推奨案 | 理由 |
|---|---|---|
| ExtensionのChrome操作API | `chrome.debugger` API | CDP直アクセスでPlaywright相当の操作が可能 |
| 認証基盤 | Supabase Auth | PostgreSQLとの統合が容易、RLS設定が自然 |
| バックエンドホスティング初期 | Railway or Render | 小規模から始めやすい、Docker対応 |
| OCR不要化 | DOM直接読み取りで代替 | Chrome ExtensionはDOMに直接アクセスできるためOCR不要 |
| テナントDB分離レベル | RLS（共有DB）で開始 | 初期フェーズはコスト優先。Enterpriseプランは個別スキーマ検討 |

---

## 9. 開発の始め方（Phase 1 開始順）

```bash
# 1. Extension の骨格
mkdir -p extension/background extension/content extension/popup extension/utils
cd extension && npm init -y && npm install typescript @types/chrome

# 2. ai-engine のセットアップ
mkdir -p ai-engine/prompts
cd ai-engine && npm init -y && npm install @anthropic-ai/sdk typescript

# 3. 最初に作るファイル
# extension/content/watcher.ts         - DOMイベントキャプチャ
# extension/utils/anonymizer.ts        - 匿名化
# ai-engine/client.ts                  - Claude API唯一の入口
# ai-engine/prompts/flow_analysis.md   - 分析プロンプト
```
