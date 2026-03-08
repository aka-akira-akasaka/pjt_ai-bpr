// バックグラウンドからイベントを取得してUI表示・エクスポートを行う

const countEl = document.getElementById('count')!;

async function refreshCount(): Promise<void> {
  const response = await chrome.runtime.sendMessage({ type: 'GET_EVENTS' }) as { events: unknown[] };
  countEl.textContent = String(response.events.length);
}

document.getElementById('btn-export')!.addEventListener('click', async () => {
  const response = await chrome.runtime.sendMessage({ type: 'GET_EVENTS' }) as { events: unknown[] };
  // JSONでダウンロード（Phase1デバッグ用）
  const blob = new Blob([JSON.stringify(response.events, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `capture_${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('btn-clear')!.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({ type: 'CLEAR_EVENTS' });
  countEl.textContent = '0';
});

// 開いた際に件数を更新
refreshCount().catch(console.error);
