import { describe, it, expect } from 'vitest';
import { formatToolCatalog, type CatalogRow } from '../src/api/skill-console-create.js';

// The 36-tool gmail server in catalog (name-ASC) order — the same shape the
// draft endpoint reads from vodou-core.db. The inbox-triage tools an
// unsubscribe skill needs (message_*/messages_list) sort AFTER an alphabetical
// 14-cap, so the old flat cap hid them from the drafter.
const GMAIL_TOOLS = [
  'attachment_get', 'draft_create', 'draft_delete', 'draft_get', 'draft_send',
  'draft_update', 'drafts_list', 'filter_create', 'filter_delete', 'filter_get',
  'filters_list', 'get_profile', 'label_create', 'label_delete', 'label_get',
  'label_update', 'labels_list', 'message_archive', 'message_delete',
  'message_forward', 'message_get', 'message_modify', 'message_send',
  'message_trash', 'message_untrash', 'messages_batch_delete',
  'messages_batch_modify', 'messages_list', 'thread_delete', 'thread_get',
  'thread_modify', 'thread_trash', 'thread_untrash', 'threads_list',
  'vacation_get', 'vacation_set',
];

// A big, unrelated server that should stay slim-capped.
const MONDAY_TOOLS = Array.from({ length: 30 }, (_, i) => `board_op_${i + 1}`);

function rowsFor(servers: Record<string, string[]>): CatalogRow[] {
  const out: CatalogRow[] = [];
  for (const [server, tools] of Object.entries(servers)) {
    for (const tool of tools) out.push({ server, tool });
  }
  return out;
}

/** The block for one server: its `- <server>` header line + indented tool lines. */
function sectionFor(catalog: string, server: string): string {
  const lines = catalog.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`- ${server}:`) || l.startsWith(`- ${server} (`));
  if (start < 0) return '';
  let end = start + 1;
  while (end < lines.length && !lines[end].startsWith('- ')) end++;
  return lines.slice(start, end).join('\n');
}

describe('formatToolCatalog', () => {
  const rows = rowsFor({ gmail: GMAIL_TOOLS, monday: MONDAY_TOOLS });

  it('expands a server named in the idea to its FULL tool list', () => {
    const idea = 'connect to gmail to find newsletters I never read and unsubscribe, run once a day';
    const cat = formatToolCatalog(rows, idea);
    const gmail = sectionFor(cat, 'gmail');
    // Tools the unsubscribe skill needs — previously hidden by the 14-tool
    // alphabetical cap — must now be visible, fully-qualified.
    expect(gmail).toContain('gmail/messages_list');
    expect(gmail).toContain('gmail/message_modify');
    expect(gmail).toContain('gmail/message_archive');
    expect(gmail).toContain('(36 tools)');
    expect(gmail).not.toContain('more)'); // nothing truncated for the relevant server
  });

  it('renders tool descriptions for expanded servers when present', () => {
    const withDesc: CatalogRow[] = [
      { server: 'gmail', tool: 'messages_list', description: 'List messages in the mailbox, with optional Gmail query' },
      { server: 'gmail', tool: 'message_modify', description: 'Add or remove labels on a message' },
    ];
    const cat = formatToolCatalog(withDesc, 'use gmail to triage messages');
    expect(cat).toContain('gmail/messages_list — List messages in the mailbox');
    expect(cat).toContain('gmail/message_modify — Add or remove labels on a message');
  });

  it('truncates an over-long description', () => {
    const long = 'x'.repeat(200);
    const cat = formatToolCatalog([{ server: 'gmail', tool: 'messages_list', description: long }], 'gmail triage');
    const line = cat.split('\n').find((l) => l.includes('gmail/messages_list')) ?? '';
    expect(line).toContain('…');
    expect(line.length).toBeLessThan(120);
  });

  it('keeps unrelated big servers slim-capped with a (+N more) marker', () => {
    const idea = 'connect to gmail and clean up my inbox';
    const cat = formatToolCatalog(rows, idea);
    const monday = sectionFor(cat, 'monday');
    expect(monday).toContain('…(+24 more)'); // 30 tools - 6 slim cap
    expect(monday).toContain('board_op_1');
    expect(monday).not.toContain('board_op_7');
  });

  it('shows terse descriptions for slim-server tools when present', () => {
    const withDesc: CatalogRow[] = [
      ...rowsFor({ gmail: GMAIL_TOOLS }),
      { server: 'exa', tool: 'search', description: 'Web search via Exa neural index' },
      { server: 'exa', tool: 'find_similar', description: 'Find pages similar to a URL' },
    ];
    const cat = formatToolCatalog(withDesc, 'use gmail to triage my inbox');
    const exa = sectionFor(cat, 'exa'); // slim — not named in the idea
    expect(exa).toContain('search (Web search via Exa neural index)');
    expect(exa).toContain('; '); // semicolon-separated (descriptions contain commas)
  });

  it('ranks the relevant server first', () => {
    const cat = formatToolCatalog(rows, 'gmail inbox cleanup');
    expect(cat.split('\n')[0].startsWith('- gmail (')).toBe(true);
  });

  it('matches a server via a tool-name token, not just its name', () => {
    // "threads" never names the server but is a gmail tool token (threads_list).
    const cat = formatToolCatalog(rows, 'summarize my unread email threads every morning');
    expect(sectionFor(cat, 'gmail')).toContain('gmail/threads_list');
  });

  it('does NOT over-expand on generic CRUD tokens like "list"', () => {
    // "list everything" must not expand a 30-tool server just because most
    // servers have *_list tools. Both stay in the compact (slim) one-line form.
    const cat = formatToolCatalog(rows, 'list everything for me');
    expect(sectionFor(cat, 'monday')).toContain('…(+24 more)');
    expect(cat).toMatch(/^- gmail: /m); // slim one-line form, not "- gmail (36 tools):"
  });

  it('returns empty string for no rows', () => {
    expect(formatToolCatalog([], 'anything')).toBe('');
  });
});
