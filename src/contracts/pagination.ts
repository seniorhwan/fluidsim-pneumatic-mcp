import { EngineeringError } from './errors';

export const DEFAULT_MAX_PAYLOAD_BYTES = 32_768;
export const DEFAULT_PAGE_LIMIT = 50;

export interface PageRequest {
  cursor?: string;
  limit?: number;
  maxBytes?: number;
}

export interface PageMeta {
  total: number;
  returned: number;
  nextCursor: string | null;
  truncatedByBudget: boolean;
  payloadBytes: number;
}

export interface PaginatedResult<T> {
  items: T[];
  page: PageMeta;
}

export function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeCursor(cursor?: string): number {
  if (!cursor) return 0;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { o?: unknown };
    if (typeof parsed.o !== 'number' || !Number.isInteger(parsed.o) || parsed.o < 0) {
      throw new Error('Invalid cursor offset');
    }
    return parsed.o;
  } catch {
    throw new EngineeringError({
      category: 'InvalidTopology',
      code: 'INVALID_CURSOR',
      message: `Pagination cursor "${cursor}" is malformed.`,
      offendingIds: [],
      suggestedFix: 'Omit cursor to start from the first page, or pass nextCursor from the previous response.',
    });
  }
}

export function byteLengthUtf8(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

export function paginateWithBudget<T>(
  allItems: readonly T[],
  req: PageRequest = {},
  defaultMaxBytes = DEFAULT_MAX_PAYLOAD_BYTES,
): PaginatedResult<T> {
  const offset = decodeCursor(req.cursor);
  const limit = Math.max(1, Math.min(req.limit ?? DEFAULT_PAGE_LIMIT, 500));
  const maxBytes = Math.max(256, req.maxBytes ?? defaultMaxBytes);

  if (offset >= allItems.length) {
    const empty: PaginatedResult<T> = {
      items: [],
      page: {
        total: allItems.length,
        returned: 0,
        nextCursor: null,
        truncatedByBudget: false,
        payloadBytes: 0,
      },
    };
    empty.page.payloadBytes = byteLengthUtf8(empty);
    return empty;
  }

  const items: T[] = [];
  let truncatedByBudget = false;
  // Reserve headroom for envelope metadata
  const overhead = 240;
  let runningBytes = overhead;

  for (let i = offset; i < Math.min(allItems.length, offset + limit); i++) {
    const item = allItems[i];
    const itemBytes = byteLengthUtf8(item) + 2;
    if (runningBytes + itemBytes > maxBytes) {
      if (items.length === 0) {
        throw new EngineeringError({
          category: 'PayloadBudgetExceeded',
          code: 'ITEM_EXCEEDS_PAYLOAD_BUDGET',
          message: `Single item at offset ${i} (${itemBytes} bytes) exceeds maxBytes=${maxBytes}.`,
          offendingIds: [],
          suggestedFix: `Increase maxBytes above ${itemBytes + overhead} or narrow query filters.`,
        });
      }
      truncatedByBudget = true;
      break;
    }
    items.push(item);
    runningBytes += itemBytes;
  }

  const nextOffset = offset + items.length;
  const nextCursor = nextOffset < allItems.length ? encodeCursor(nextOffset) : null;

  const result: PaginatedResult<T> = {
    items,
    page: {
      total: allItems.length,
      returned: items.length,
      nextCursor,
      truncatedByBudget,
      payloadBytes: 0,
    },
  };
  result.page.payloadBytes = byteLengthUtf8(result);
  return result;
}

export function assertPayloadBudget(
  payload: unknown,
  maxBytes = DEFAULT_MAX_PAYLOAD_BYTES,
  contextLabel = 'tool response',
): number {
  const bytes = byteLengthUtf8(payload);
  if (bytes > maxBytes) {
    throw new EngineeringError({
      category: 'PayloadBudgetExceeded',
      code: 'PAYLOAD_BUDGET_EXCEEDED',
      message: `${contextLabel} size (${bytes} bytes) exceeds configured budget (${maxBytes} bytes).`,
      offendingIds: [],
      suggestedFix: 'Use narrower filters, compact-text format, cursor pagination, or raise maxBytes.',
      details: { bytes, maxBytes },
    });
  }
  return bytes;
}
