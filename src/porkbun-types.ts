export interface PorkbunDnsRecord {
  id: string;
  name?: string;
  type: string;
  content: string;
  ttl?: number;
  prio?: number;
  notes?: string;
}

export function extractDnsRecords(payload: unknown): PorkbunDnsRecord[] {
  if (!isRecord(payload)) {
    return [];
  }

  const directRecords = extractRecordArray(payload.records);
  if (directRecords.length > 0) {
    return directRecords;
  }

  const single = toDnsRecord(payload);
  if (single) {
    return [single];
  }

  return [];
}

export function recordsEqual(
  record: PorkbunDnsRecord,
  target: {
    content: string;
    ttl?: number;
    prio?: number;
    notes?: string;
  },
): boolean {
  if (record.content !== target.content) {
    return false;
  }
  if (target.ttl !== undefined && record.ttl !== target.ttl) {
    return false;
  }
  if (target.prio !== undefined && record.prio !== target.prio) {
    return false;
  }
  if (target.notes !== undefined && (record.notes ?? "") !== target.notes) {
    return false;
  }
  return true;
}

function extractRecordArray(value: unknown): PorkbunDnsRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map(toDnsRecord).filter((item): item is PorkbunDnsRecord => !!item);
}

function toDnsRecord(value: unknown): PorkbunDnsRecord | null {
  if (!isRecord(value)) {
    return null;
  }

  const id =
    readString(value.id) ??
    readString(value.record_id) ??
    readString(value.pk) ??
    readString(value.keyTag);
  const type = readString(value.type);
  const content = readString(value.content) ?? readString(value.answer);

  if (!id || !type || content === null) {
    return null;
  }

  return {
    id,
    name: readString(value.name) ?? undefined,
    type,
    content,
    ttl: readNumber(value.ttl),
    prio: readNumber(value.prio),
    notes: readString(value.notes) ?? undefined,
  };
}

function readString(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  return null;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
