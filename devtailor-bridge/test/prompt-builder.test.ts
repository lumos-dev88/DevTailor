import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildPrompt } from '../src/prompt-builder';
import { ReviewPayload } from '../src/types';

describe('prompt-builder', () => {
  const payload: ReviewPayload['payload'] = {
    pageUrl: 'http://localhost:3000/dashboard',
    userIntent: '卡片圆角改 12px，按钮换成 outline',
    screenshot: null,
    items: [
      {
        index: 1,
        selector: '.card.dashboard-item',
        xpath: '//div[contains(@class,"card")]',
        outerHTML: '<div class="card dashboard-item" style="border-radius:8px">...</div>',
        computedStyle: { borderRadius: '8px', padding: '16px', backgroundColor: '#fff' },
        annotation: '圆角太小了，改成 12px',
        text: 'Dashboard Card',
        boundingBox: { x: 100, y: 200, w: 300, h: 150 },
        framework: { framework: 'react', componentName: 'DashboardCard', filePath: 'src/components/DashboardCard.tsx' },
      },
      {
        index: 2,
        selector: 'button.btn-primary',
        xpath: '//button',
        outerHTML: '<button class="btn-primary">Save</button>',
        computedStyle: { color: '#fff', backgroundColor: '#3b82f6' },
        annotation: '换成 outline 样式',
        text: 'Save',
        boundingBox: null,
        framework: null,
      },
    ],
  };

  it('returns ContentBlock array', () => {
    const blocks = buildPrompt(payload);
    assert.ok(Array.isArray(blocks));
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'text');
  });

  it('includes page URL', () => {
    const blocks = buildPrompt(payload);
    const text = (blocks[0] as any).text;
    assert.ok(text.includes('http://localhost:3000/dashboard'));
  });

  it('includes user intent', () => {
    const blocks = buildPrompt(payload);
    const text = (blocks[0] as any).text;
    assert.ok(text.includes('卡片圆角改 12px，按钮换成 outline'));
  });

  it('includes all selectors', () => {
    const blocks = buildPrompt(payload);
    const text = (blocks[0] as any).text;
    assert.ok(text.includes('.card.dashboard-item'));
    assert.ok(text.includes('button.btn-primary'));
  });

  it('includes annotations', () => {
    const blocks = buildPrompt(payload);
    const text = (blocks[0] as any).text;
    assert.ok(text.includes('圆角太小了，改成 12px'));
    assert.ok(text.includes('换成 outline 样式'));
  });

  it('includes framework info', () => {
    const blocks = buildPrompt(payload);
    const text = (blocks[0] as any).text;
    assert.ok(text.includes('DashboardCard'));
    assert.ok(text.includes('src/components/DashboardCard.tsx'));
  });

  it('includes computed styles', () => {
    const blocks = buildPrompt(payload);
    const text = (blocks[0] as any).text;
    assert.ok(text.includes('borderRadius: 8px'));
    assert.ok(text.includes('padding: 16px'));
  });

  it('includes outerHTML', () => {
    const blocks = buildPrompt(payload);
    const text = (blocks[0] as any).text;
    assert.ok(text.includes('<div class="card dashboard-item"'));
  });

  it('includes bounding box when present', () => {
    const blocks = buildPrompt(payload);
    const text = (blocks[0] as any).text;
    assert.ok(text.includes('x=100'));
    assert.ok(text.includes('y=200'));
  });

  it('does not include framework section when null', () => {
    const blocks = buildPrompt(payload);
    const text = (blocks[0] as any).text;
    assert.ok(text.includes('button.btn-primary'));
  });

  it('shows fallback when no user intent', () => {
    const blocks = buildPrompt({ ...payload, userIntent: '' });
    const text = (blocks[0] as any).text;
    assert.ok(text.includes('No additional description provided'));
  });

  it('includes image block when screenshot is provided', () => {
    const screenshot = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==';
    const blocks = buildPrompt({ ...payload, screenshot });
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[1].type, 'image');
    assert.strictEqual((blocks[1] as any).mimeType, 'image/jpeg');
    assert.strictEqual((blocks[1] as any).data, '/9j/4AAQSkZJRgABAQ==');
  });

  it('includes png image block when screenshot is png', () => {
    const screenshot = 'data:image/png;base64,iVBORw0KGgo=';
    const blocks = buildPrompt({ ...payload, screenshot });
    assert.strictEqual(blocks.length, 2);
    assert.strictEqual(blocks[1].type, 'image');
    assert.strictEqual((blocks[1] as any).mimeType, 'image/png');
    assert.strictEqual((blocks[1] as any).data, 'iVBORw0KGgo=');
  });

  it('includes one ACP image block per screenshot', () => {
    const screenshots = [
      'data:image/png;base64,iVBORw0KGgo=',
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ==',
    ];
    const blocks = buildPrompt({ ...payload, screenshot: null, screenshots });
    assert.strictEqual(blocks.length, 3);
    assert.strictEqual(blocks[1].type, 'image');
    assert.strictEqual(blocks[2].type, 'image');
    assert.strictEqual((blocks[1] as any).mimeType, 'image/png');
    assert.strictEqual((blocks[2] as any).mimeType, 'image/jpeg');
  });
});
