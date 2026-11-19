/**
 * Prompt Builder — turns a review payload (page, intent, marked elements)
 * into the text handed to the agent. The AI runtime is Claude Code; there is
 * no system prompt or history injection on the bridge side.
 */

import { ReviewPayload } from './types';

export type PromptContentBlock = { type: 'text'; text: string };

// ---------------------------------------------------------------------------
// User prompt — dynamic data, sent with each request
// ---------------------------------------------------------------------------

export interface BuildPromptOptions {
  /** Absolute paths of enabled DESIGN.md files, in enable order (later wins). */
  designDocPaths?: string[];
}

export function buildPrompt(payload: ReviewPayload['payload'], options: BuildPromptOptions = {}): PromptContentBlock[] {
  const { pageUrl, userIntent, items } = payload;
  const intent = userIntent || '(No additional description provided)';
  const hasMarks = items.length > 0;

  let text = '';

  text += `## Current Page\nURL: ${pageUrl}\n\n`;
  text += `## User Intent\n${intent}\n\n`;

  if (hasMarks) {
    text += `## Marked Elements (${items.length} total)\n\n`;
    for (const item of items) {
      text += `### ${item.index} \`${item.selector}\`\n`;
      if (item.annotation) {
        text += `- **User annotation**: ${item.annotation}\n`;
      }
      if (item.framework?.filePath) {
        text += `- **Component file**: ${item.framework.filePath}\n`;
      }
      if (item.framework?.componentName) {
        text += `- **Component name**: ${item.framework.componentName}\n`;
      }
      if (item.computedStyle && Object.keys(item.computedStyle).length > 0) {
        const styles = Object.entries(item.computedStyle)
          .filter(([, v]) => v && v !== 'none' && v !== 'normal' && v !== '0px')
          .map(([k, v]) => `  - ${k}: ${v}`)
          .join('\n');
        if (styles) text += `- **Computed Styles**:\n${styles}\n`;
      }
      if (item.outerHTML) {
        text += `- **DOM Structure**:\n\`\`\`html\n${item.outerHTML}\n\`\`\`\n`;
      }
      if (item.boundingBox) {
        const b = item.boundingBox;
        text += `- **Bounding Box**: x=${Math.round(b.x)}, y=${Math.round(b.y)}, w=${Math.round(b.w)}, h=${Math.round(b.h)}\n`;
      }
      text += '\n';
    }
  } else {
    text += `## Marked Elements\nNo elements were marked. Use the user's request as the primary context.\n\n`;
  }

  const designPaths = (options.designDocPaths ?? []).filter(p => typeof p === 'string' && p);
  if (designPaths.length > 0) {
    text += `## Design Spec\n`;
    for (const p of designPaths) text += `- ${p}\n`;
    text += 'Read these design spec files before making changes. All style and component changes must follow them. '
      + 'If they conflict, the later file takes precedence. Where the spec says nothing, keep the existing style. '
      + 'If the project has its own frontend standard (CLAUDE.md, CODE_STANDARD, etc.) that contradicts a spec rule, the project standard wins; say which rule you followed.\n\n';
  }

  return [{ type: 'text', text }];
}
