import { anonymize } from '../utils/anonymizer.js';

// バックグラウンドに送信するイベント型
interface CaptureEvent {
  sessionId: string;
  timestamp: number;
  // originのみ（パス・クエリはマスク済み）
  url: string;
  eventType: 'click' | 'input' | 'navigation' | 'copy' | 'paste';
  targetSelector: string;
  value?: string;
}

// セッションIDはストレージから取得（テナントID + ランダム）
let sessionId = '';

async function initSessionId(): Promise<void> {
  const result = await chrome.storage.local.get('sessionId');
  if (result['sessionId']) {
    sessionId = result['sessionId'] as string;
  } else {
    sessionId = crypto.randomUUID();
    await chrome.storage.local.set({ sessionId });
  }
}

// DOMセレクタを生成（個人情報を含まない形式）
function buildSelector(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const cls = el.className
    ? '.' + String(el.className).trim().split(/\s+/).slice(0, 2).join('.')
    : '';
  return `${tag}${id}${cls}` || tag;
}

// 機密フィールドかどうかを判定
function isSensitiveField(el: Element): boolean {
  if (!(el instanceof HTMLInputElement)) return false;
  const sensitiveTypes = ['password', 'email', 'tel', 'credit-card'];
  const autocomplete = el.getAttribute('autocomplete') ?? '';
  return (
    sensitiveTypes.includes(el.type) ||
    autocomplete.includes('cc-') ||
    autocomplete === 'current-password' ||
    autocomplete === 'new-password'
  );
}

function sendEvent(event: CaptureEvent): void {
  chrome.runtime.sendMessage({ type: 'CAPTURE_EVENT', payload: event });
}

function buildBaseEvent(
  eventType: CaptureEvent['eventType'],
  el: Element
): CaptureEvent {
  return {
    sessionId,
    timestamp: Date.now(),
    url: window.location.origin,
    eventType,
    targetSelector: buildSelector(el),
  };
}

// クリックイベントの収集
document.addEventListener(
  'click',
  (e: MouseEvent) => {
    const target = e.target as Element;
    if (!target) return;
    sendEvent(buildBaseEvent('click', target));
  },
  { capture: true, passive: true }
);

// inputイベントの収集（500ms デバウンス）
let inputTimer: ReturnType<typeof setTimeout> | null = null;
document.addEventListener(
  'input',
  (e: Event) => {
    const target = e.target as HTMLInputElement;
    if (!target) return;
    // 機密フィールドはスキップ
    if (isSensitiveField(target)) return;

    if (inputTimer) clearTimeout(inputTimer);
    inputTimer = setTimeout(() => {
      const raw = target.value ?? '';
      const event = buildBaseEvent('input', target);
      // 値は匿名化してから送信
      event.value = anonymize(raw);
      sendEvent(event);
    }, 500);
  },
  { capture: true, passive: true }
);

// コピー・ペーストイベントの収集（値は送らない）
document.addEventListener(
  'copy',
  (e: ClipboardEvent) => {
    const target = e.target as Element;
    if (!target) return;
    sendEvent(buildBaseEvent('copy', target));
  },
  { capture: true, passive: true }
);

document.addEventListener(
  'paste',
  (e: ClipboardEvent) => {
    const target = e.target as Element;
    if (!target) return;
    sendEvent(buildBaseEvent('paste', target));
  },
  { capture: true, passive: true }
);

// ページナビゲーションの収集
window.addEventListener('popstate', () => {
  sendEvent({
    sessionId,
    timestamp: Date.now(),
    url: window.location.origin,
    eventType: 'navigation',
    targetSelector: 'window',
  });
});

// 初期化
initSessionId().catch(console.error);
