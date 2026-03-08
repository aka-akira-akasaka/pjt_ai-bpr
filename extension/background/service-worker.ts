// CaptureEventの型定義（content/watcher.tsと共有）
interface CaptureEvent {
  sessionId: string;
  timestamp: number;
  url: string;
  eventType: 'click' | 'input' | 'navigation' | 'copy' | 'paste';
  targetSelector: string;
  value?: string;
}

// Phase1では収集したイベントをメモリ上のバッファに蓄積し、
// ポップアップからの要求でai-engine CLIに転送する
const eventBuffer: CaptureEvent[] = [];
const BUFFER_MAX = 200;

chrome.runtime.onMessage.addListener((message: unknown) => {
  const msg = message as { type: string; payload?: CaptureEvent };
  if (msg.type === 'CAPTURE_EVENT' && msg.payload) {
    // バッファが上限を超えたら古いものを削除
    if (eventBuffer.length >= BUFFER_MAX) {
      eventBuffer.shift();
    }
    eventBuffer.push(msg.payload);
  }

  if (msg.type === 'GET_EVENTS') {
    // ポップアップからの取得要求に応答
    return true;
  }
});

// ポップアップからイベント一覧を取得するメッセージハンドラ
chrome.runtime.onMessage.addListener(
  (
    message: unknown,
    _sender: chrome.runtime.MessageSender,
    sendResponse: (response: unknown) => void
  ) => {
    const msg = message as { type: string };
    if (msg.type === 'GET_EVENTS') {
      sendResponse({ events: eventBuffer });
      return true;
    }
    if (msg.type === 'CLEAR_EVENTS') {
      eventBuffer.length = 0;
      sendResponse({ ok: true });
      return true;
    }
  }
);
