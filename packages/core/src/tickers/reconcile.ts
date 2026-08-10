import {
  TickerProfile,
  type PartialTickerProfile,
  type TickerSourceAttribution,
} from '../schemas/ticker.js';
import type { TickerSource } from './source.js';

const REQUIRED_SCALAR_FIELDS = ['symbol', 'name', 'exchange'] as const;
const CORE_OPTIONAL_SCALAR_FIELDS = ['sector', 'industry', 'description'] as const;
const EXTENDED_OPTIONAL_SCALAR_FIELDS = [
  'type',
  'currency',
  'country',
  'cik',
  'isin',
  'cusip',
  'website',
  'logoUrl',
] as const;
const OPTIONAL_SCALAR_FIELDS = [
  ...CORE_OPTIONAL_SCALAR_FIELDS,
  ...EXTENDED_OPTIONAL_SCALAR_FIELDS,
] as const;
const ALL_SCALAR_FIELDS = [...REQUIRED_SCALAR_FIELDS, ...OPTIONAL_SCALAR_FIELDS] as const;

type RequiredScalarField = (typeof REQUIRED_SCALAR_FIELDS)[number];
type OptionalScalarField = (typeof OPTIONAL_SCALAR_FIELDS)[number];
export type ReconcileScalarField = RequiredScalarField | OptionalScalarField;

interface FieldVoteEntry {
  sourceName: string;
  sourceWeight: number;
  rawValue: string;
  normalizedValue: string;
}

interface CandidateAggregate {
  normalizedValue: string;
  totalWeight: number;
  topSourceWeight: number;
  representativeValue: string;
  sourceNames: string[];
}

export interface ReconcileConflict {
  field: ReconcileScalarField;
  threshold: number;
  selectedValue: string;
  selectedWeight: number;
  totalWeight: number;
  consensus: number;
  candidates: Array<{
    normalizedValue: string;
    representativeValue: string;
    totalWeight: number;
    sourceNames: string[];
  }>;
}

export class ReconcileConflictError extends Error {
  readonly conflicts: ReconcileConflict[];
  readonly notes: string[];

  constructor(message: string, conflicts: ReconcileConflict[], notes: string[]) {
    super(message);
    this.name = 'ReconcileConflictError';
    this.conflicts = conflicts;
    this.notes = notes;
  }
}

export interface ReconcileInput {
  source: Pick<TickerSource, 'name' | 'weight'>;
  partial: PartialTickerProfile;
}

export interface ReconcileOptions {
  /** Sum of all configured source weights consulted by the resolver. */
  totalWeight: number;
  /** ISO timestamp to stamp in the reconciled profile. */
  validatedAt: string;
  /** Minimum consensus share required for disputed fields. */
  conflictThreshold?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeNameForVote(value: string): string {
  const suffixes = new Set([
    'inc',
    'incorporated',
    'corp',
    'corporation',
    'co',
    'company',
    'ltd',
    'limited',
    'plc',
    'holdings',
    'holding',
    'group',
  ]);
  const parts = value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((part) => part.length > 0);

  while (parts.length > 0 && suffixes.has(parts[parts.length - 1] ?? '')) {
    parts.pop();
  }

  return parts.join(' ').trim();
}

function normalizeForVote(field: ReconcileScalarField, value: string): string {
  if (field === 'name') {
    return normalizeNameForVote(value);
  }
  if (field === 'symbol') {
    return value.trim().toUpperCase();
  }
  return value.trim().toLowerCase();
}

function getScalarValue(partial: PartialTickerProfile, field: ReconcileScalarField): string | null {
  const value = partial[field];
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function dedupeStrings(items: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}

function dedupeSourceAttributions(
  items: ReadonlyArray<TickerSourceAttribution>,
): TickerSourceAttribution[] {
  const byKey = new Map<string, TickerSourceAttribution>();

  for (const item of items) {
    const key = `${item.name}\u0000${item.url}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    if (item.confidence > existing.confidence) {
      byKey.set(key, item);
    }
  }

  return [...byKey.values()];
}

function aggregateField(
  field: ReconcileScalarField,
  entries: FieldVoteEntry[],
  conflictThreshold: number,
): {
  selectedValue: string | null;
  note: string | null;
  conflict: ReconcileConflict | null;
} {
  if (entries.length === 0) {
    return { selectedValue: null, note: null, conflict: null };
  }

  const byNormalized = new Map<string, CandidateAggregate>();
  for (const entry of entries) {
    const key = entry.normalizedValue;
    const existing = byNormalized.get(key);
    if (!existing) {
      byNormalized.set(key, {
        normalizedValue: key,
        totalWeight: entry.sourceWeight,
        topSourceWeight: entry.sourceWeight,
        representativeValue: entry.rawValue,
        sourceNames: [entry.sourceName],
      });
      continue;
    }

    existing.totalWeight += entry.sourceWeight;
    if (entry.sourceWeight > existing.topSourceWeight) {
      existing.topSourceWeight = entry.sourceWeight;
      existing.representativeValue = entry.rawValue;
    }
    if (!existing.sourceNames.includes(entry.sourceName)) {
      existing.sourceNames.push(entry.sourceName);
    }
  }

  const candidates = [...byNormalized.values()].sort((a, b) => {
    if (b.totalWeight !== a.totalWeight) {
      return b.totalWeight - a.totalWeight;
    }
    if (b.topSourceWeight !== a.topSourceWeight) {
      return b.topSourceWeight - a.topSourceWeight;
    }
    return a.representativeValue.localeCompare(b.representativeValue);
  });

  const winner = candidates[0]!;
  const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.totalWeight, 0);
  const consensus = totalWeight > 0 ? winner.totalWeight / totalWeight : 1;

  let note: string | null = null;
  if (candidates.length > 1) {
    const breakdown = candidates
      .map((candidate) => {
        const sourceList = candidate.sourceNames.join(', ');
        return `"${candidate.representativeValue}" (${candidate.totalWeight.toFixed(2)} from ${sourceList})`;
      })
      .join(' vs ');
    note = `${field} disagreement: selected "${winner.representativeValue}"; candidates: ${breakdown}`;
  }

  const conflict: ReconcileConflict | null =
    candidates.length > 1 && consensus < conflictThreshold
      ? {
          field,
          threshold: conflictThreshold,
          selectedValue: winner.representativeValue,
          selectedWeight: winner.totalWeight,
          totalWeight,
          consensus,
          candidates: candidates.map((candidate) => ({
            normalizedValue: candidate.normalizedValue,
            representativeValue: candidate.representativeValue,
            totalWeight: candidate.totalWeight,
            sourceNames: [...candidate.sourceNames],
          })),
        }
      : null;

  return {
    selectedValue: winner.representativeValue,
    note,
    conflict,
  };
}

export function reconcile(inputs: ReadonlyArray<ReconcileInput>, options: ReconcileOptions): TickerProfile {
  if (inputs.length === 0) {
    throw new Error('reconcile: no partials');
  }

  const conflictThreshold = clamp(options.conflictThreshold ?? 0.55, 0, 1);
  const notes: string[] = [];
  const conflicts: ReconcileConflict[] = [];

  const selected: Record<ReconcileScalarField, string | null> = {
    symbol: null,
    name: null,
    exchange: null,
    sector: null,
    industry: null,
    description: null,
    type: null,
    currency: null,
    country: null,
    cik: null,
    isin: null,
    cusip: null,
    website: null,
    logoUrl: null,
  };

  for (const field of ALL_SCALAR_FIELDS) {
    const entries: FieldVoteEntry[] = inputs
      .map((input) => {
        const value = getScalarValue(input.partial, field);
        if (value === null) {
          return null;
        }
        return {
          sourceName: input.source.name,
          sourceWeight: input.source.weight,
          rawValue: value,
          normalizedValue: normalizeForVote(field, value),
        };
      })
      .filter((entry): entry is FieldVoteEntry => entry !== null);

    const result = aggregateField(field, entries, conflictThreshold);
    selected[field] = result.selectedValue;
    if (result.note !== null) {
      notes.push(result.note);
    }
    if (result.conflict !== null) {
      conflicts.push(result.conflict);
    }
  }

  if (selected.name === null || selected.exchange === null || selected.symbol === null) {
    throw new Error('reconcile: missing required field (symbol, name, or exchange)');
  }

  const hardConflictFields = new Set(
    conflicts
      .filter(
        (conflict) =>
          conflict.field === 'symbol' || conflict.field === 'name' || conflict.field === 'exchange',
      )
      .map((conflict) => conflict.field),
  );

  const hasUnresolvableIdentityConflict =
    hardConflictFields.has('symbol') ||
    (hardConflictFields.has('name') && hardConflictFields.has('exchange'));

  if (hasUnresolvableIdentityConflict) {
    throw new ReconcileConflictError(
      'reconcile: source candidates conflict beyond threshold',
      conflicts,
      notes,
    );
  }

  const sourceUrls = dedupeStrings(inputs.flatMap((input) => input.partial.sourceUrls ?? []));

  const contributingWeight = inputs.reduce((sum, input) => sum + input.source.weight, 0);
  const denominator = options.totalWeight > 0 ? options.totalWeight : contributingWeight;

  const sources = dedupeSourceAttributions(
    inputs.flatMap((input) => {
      const urls = dedupeStrings(input.partial.sourceUrls ?? []);
      const sourceConfidence = denominator > 0 ? clamp(input.source.weight / denominator, 0, 1) : 0;
      if (urls.length === 0) {
        return [
          {
            name: input.source.name,
            url: input.source.name,
            confidence: sourceConfidence,
          },
        ];
      }
      return urls.map((url) => ({
        name: input.source.name,
        url,
        confidence: sourceConfidence,
      }));
    }),
  );

  const baseConfidence = denominator > 0 ? contributingWeight / denominator : 0;

  const optionalFilled = CORE_OPTIONAL_SCALAR_FIELDS.filter((field) => selected[field] !== null).length;
  const optionalCoverage =
    CORE_OPTIONAL_SCALAR_FIELDS.length > 0
      ? optionalFilled / CORE_OPTIONAL_SCALAR_FIELDS.length
      : 1;
  const coverageScale = 0.7 + 0.3 * optionalCoverage;

  const confidence = clamp(baseConfidence * coverageScale, 0, 1);

  return TickerProfile.parse({
    symbol: selected.symbol,
    name: selected.name,
    exchange: selected.exchange,
    type: selected.type,
    currency: selected.currency,
    country: selected.country,
    sector: selected.sector,
    industry: selected.industry,
    cik: selected.cik,
    isin: selected.isin,
    cusip: selected.cusip,
    website: selected.website,
    description: selected.description,
    logoUrl: selected.logoUrl,
    sourceUrls,
    validatedAt: options.validatedAt,
    resolvedAt: options.validatedAt,
    confidence,
    sources,
    notes,
  });
}
