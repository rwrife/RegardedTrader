import type { NewsNewEvent } from './jobs/news.js';
import type { OptionsUpdateEvent } from './jobs/options.js';
import type { QuoteUpdateEvent } from './jobs/quote.js';
import type { JobStatus } from './scheduler.js';

/** Scheduler / poller lifecycle signal for channel `job.state`. */
export interface PollingJobStateEvent {
  readonly type: 'job.state';
  readonly jobId: string;
  readonly status: JobStatus;
  /** Optional symbol scope for this job (e.g. ['NVDA']). */
  readonly symbols?: readonly string[];
  /** ISO timestamp when this state was observed. */
  readonly at: string;
  /** Optional human-readable diagnostics for failures/backoff transitions. */
  readonly detail?: string;
}

/** All event payloads the polling bus can carry. */
export type PollingEvent =
  | QuoteUpdateEvent
  | OptionsUpdateEvent
  | NewsNewEvent
  | PollingJobStateEvent;

/** Literal channel names exposed by the bus. */
export type PollingChannel = PollingEvent['type'];

type ChannelEvent<T extends PollingChannel> = Extract<PollingEvent, { type: T }>;
type ChannelListener<T extends PollingChannel> = (event: ChannelEvent<T>) => void;
type AnyListener = (event: PollingEvent) => void;

export interface PollingEventBusOptions {
  /** Optional diagnostics hook; listener errors are swallowed after this callback. */
  readonly onListenerError?: (channel: PollingChannel | '*', err: unknown) => void;
}

/**
 * Tiny typed in-process event bus for polling updates.
 *
 * Channels are fixed to the documented v1 set:
 *   - quote.update
 *   - options.update
 *   - news.new
 *   - job.state
 */
export class PollingEventBus {
  private readonly listeners: {
    'quote.update': Set<ChannelListener<'quote.update'>>;
    'options.update': Set<ChannelListener<'options.update'>>;
    'news.new': Set<ChannelListener<'news.new'>>;
    'job.state': Set<ChannelListener<'job.state'>>;
  } = {
    'quote.update': new Set(),
    'options.update': new Set(),
    'news.new': new Set(),
    'job.state': new Set(),
  };

  private readonly anyListeners = new Set<AnyListener>();
  private readonly onListenerError?: (channel: PollingChannel | '*', err: unknown) => void;

  constructor(opts: PollingEventBusOptions = {}) {
    this.onListenerError = opts.onListenerError;
  }

  on<T extends PollingChannel>(channel: T, listener: ChannelListener<T>): () => void {
    const set = this.listeners[channel] as unknown as Set<ChannelListener<T>>;
    set.add(listener);
    let unsubbed = false;
    return () => {
      if (unsubbed) return;
      unsubbed = true;
      set.delete(listener);
    };
  }

  onAny(listener: AnyListener): () => void {
    this.anyListeners.add(listener);
    let unsubbed = false;
    return () => {
      if (unsubbed) return;
      unsubbed = true;
      this.anyListeners.delete(listener);
    };
  }

  emit(event: PollingEvent): void {
    const channel = event.type;
    const channelSet = this.listeners[channel] as Set<(e: PollingEvent) => void>;

    for (const listener of [...channelSet]) {
      try {
        listener(event);
      } catch (err) {
        this.onListenerError?.(channel, err);
      }
    }

    for (const listener of [...this.anyListeners]) {
      try {
        listener(event);
      } catch (err) {
        this.onListenerError?.('*', err);
      }
    }
  }

  listenerCount(channel?: PollingChannel): number {
    if (!channel) {
      return (
        this.listeners['quote.update'].size +
        this.listeners['options.update'].size +
        this.listeners['news.new'].size +
        this.listeners['job.state'].size +
        this.anyListeners.size
      );
    }
    return this.listeners[channel].size;
  }
}
