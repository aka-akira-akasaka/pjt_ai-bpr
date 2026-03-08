// 個人情報カテゴリの正規表現パターン
const PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // メールアドレス
  { pattern: /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, label: '[EMAIL]' },
  // 日本の電話番号（ハイフンあり・なし）
  { pattern: /0\d{1,4}[-\s]?\d{1,4}[-\s]?\d{4}/g, label: '[PHONE]' },
  // 郵便番号
  { pattern: /〒?\d{3}[-\s]?\d{4}/g, label: '[POSTAL_CODE]' },
  // クレジットカード番号（4桁×4グループ）
  { pattern: /\b\d{4}[\s\-]?\d{4}[\s\-]?\d{4}[\s\-]?\d{4}\b/g, label: '[CREDIT_CARD]' },
  // 日本の人名（姓名パターン: 漢字2〜4文字）
  { pattern: /[\u4E00-\u9FFF]{1,4}\s*[\u4E00-\u9FFF]{1,4}(?=\s|$|さん|様|氏)/g, label: '[PERSON_NAME]' },
];

/**
 * テキストに含まれる個人情報をカテゴリラベルに置換する
 * 元の値はログ・ストレージに残さない
 */
export function anonymize(text: string): string {
  let result = text;
  for (const { pattern, label } of PATTERNS) {
    result = result.replace(pattern, label);
  }
  return result;
}

/**
 * URLからoriginのみを抽出し、パス・クエリパラメータをマスクする
 */
export function maskUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return u.origin;
  } catch {
    // URLパース失敗時は空文字を返す（生のURLを漏らさない）
    return '';
  }
}
