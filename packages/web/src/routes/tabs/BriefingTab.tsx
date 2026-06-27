import React from 'react';
import type { SampleTicker } from '../../sample-data.js';
import { AiCard } from '../../components/primitives/AiCard.js';
import { Section } from '../../components/primitives/Section.js';
import { ListSection } from '../../components/primitives/ListSection.js';
import { AiDisclaimer } from '../../components/AiDisclaimer.js';

/**
 * Default tab in the main column. Renders the sample-data bull/bear cases
 * plus catalysts/risks, and links out to the full briefing pipeline and
 * the trade-plan view. Extracted from App.tsx in #112.
 */
export function BriefingTab({ t }: { t: SampleTicker }): JSX.Element {
  const briefHref = `#/brief/${encodeURIComponent(t.symbol)}`;
  const planHref = `#/plan/${encodeURIComponent(t.symbol)}`;
  return (
    <AiCard>
      <div className="flex justify-end mb-3 gap-3">
        <a
          href={planHref}
          className="text-xs underline text-fg-secondary hover:text-fg"
          aria-label={`Open trade plan view for ${t.symbol}`}
        >
          Build trade plan →
        </a>
        <a
          href={briefHref}
          className="text-xs underline text-fg-secondary hover:text-fg"
          aria-label={`Open full briefing pipeline for ${t.symbol}`}
        >
          Open full briefing pipeline →
        </a>
      </div>
      <div className="grid md:grid-cols-2 gap-6">
        <Section title="Bull case" tone="up" body={t.briefing.bullCase} />
        <Section title="Bear case" tone="down" body={t.briefing.bearCase} />
      </div>
      <div className="grid md:grid-cols-2 gap-6 mt-6">
        <ListSection title="Catalysts" items={t.briefing.catalysts} />
        <ListSection title="Risks" items={t.briefing.risks} />
      </div>
      <AiDisclaimer marginTop="md" />
    </AiCard>
  );
}
