# pjt_ai-bpr

## プロジェクト概要

ユーザーの画面操作をリアルタイムでウォッチし、業務フローを自動的に分析・AI化・自動化するソリューション。

コンサルティングファームのヒアリングや、チームベースのBPR（Business Process Re-engineering）とは異なり、
**「何も意識をしなくても業務がAI化される」** 体験を提供することが本プロジェクトの核心的な価値です。

### アプローチの特徴

- ユーザーは業務改善のために何も「入力」「説明」「依頼」する必要がない
- 画面ウォッチ → 業務パターンの自動抽出 → AI化・自動化提案 → 実行 のパイプラインが自律的に動作する
- 段階的な自動化（提案 → 承認 → 実行 → フィードバック）

## モジュール構成（予定）

```
pjt_ai-bpr/
├── watcher/       # 画面キャプチャ・操作ログ収集モジュール
├── analyzer/      # 業務パターン分析・フロー抽出モジュール
├── ai-engine/     # Claude APIを用いたAI化提案・実行モジュール
├── automation/    # RPA・API連携による自動化実行モジュール
└── dashboard/     # 進捗可視化・承認フローUI
```

## セッション開始時にやること

1. 現在の開発ブランチを確認する
   ```
   git branch
   git status
   ```
2. 未完了タスクがあれば TODO リストを確認する
3. `watcher/` `analyzer/` `ai-engine/` `automation/` のいずれかを触る場合は、
   対応する `.claude/rules/` のルールが自動的に読み込まれます

## 技術スタック（予定）

- Runtime: Node.js / Python
- AI: Claude API（モデル使用方針は `.claude/rules/general.md` を参照）
- Screen Capture: OS ネイティブAPI / Electron
- Automation: Playwright / OS automation APIs
