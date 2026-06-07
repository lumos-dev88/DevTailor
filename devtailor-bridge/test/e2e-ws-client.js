#!/usr/bin/env node
/**
 * E2E WebSocket client — simulates DevTailor extension sending a review
 */

const WebSocket = require('ws');

const WS_URL = 'ws://localhost:34781';

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
  console.log('[E2E] Connected to bridge');

  // Send a review message
  ws.send(JSON.stringify({
    type: 'review',
    tabId: 'e2e-test-tab',
    payload: {
      pageUrl: 'http://localhost:3000/index.html',
      userIntent: 'Change the card border radius to 12px and make buttons larger',
      items: [
        {
          index: 1,
          selector: '.card',
          xpath: '//div[contains(@class,"card")]',
          outerHTML: '<div class="card" style="border-radius:8px">...</div>',
          computedStyle: { borderRadius: '8px', padding: '24px', backgroundColor: '#fff' },
          annotation: 'Border radius too small, change to 12px',
          text: 'Dashboard Card',
          boundingBox: { x: 100, y: 200, w: 300, h: 150 },
          framework: null,
        },
        {
          index: 2,
          selector: 'button.primary',
          xpath: '//button',
          outerHTML: '<button class="primary">Save</button>',
          computedStyle: { color: '#fff', backgroundColor: '#3b82f6', padding: '10px 20px' },
          annotation: 'Make button padding larger',
          text: 'Save',
          boundingBox: null,
          framework: null,
        },
      ],
      screenshot: null,
    },
  }));
});

let streamText = '';

ws.on('message', (data) => {
  const msg = JSON.parse(data.toString());

  switch (msg.type) {
    case 'pong':
      console.log('[E2E] Received pong');
      break;
    case 'stream':
      streamText += msg.delta;
      process.stdout.write(msg.delta);
      break;
    case 'done':
      console.log('\n[E2E] Done. Full text length:', streamText.length);
      ws.close();
      process.exit(0);
      break;
    case 'error':
      console.error('\n[E2E] Error:', msg.message);
      ws.close();
      process.exit(1);
      break;
    default:
      console.log('[E2E] Unknown message:', msg.type);
  }
});

ws.on('error', (err) => {
  console.error('[E2E] WS error:', err.message);
  process.exit(1);
});

ws.on('close', () => {
  console.log('[E2E] Connection closed');
});

// Timeout after 120s
setTimeout(() => {
  console.error('[E2E] Timeout waiting for response');
  ws.close();
  process.exit(1);
}, 120000);
